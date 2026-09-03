#!/usr/bin/env python3
from __future__ import annotations

import os

import argparse
import getpass
import hashlib
import html
import http.cookiejar
import json
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from child_device_discovery import (
    ChildDeviceDiscoveryEngine,
    DeviceCandidate,
    DeviceCredential,
    DiscoveredEndpoint,
)

VERSION = "0.1.0"
USER_AGENT = f"PSOP-Speco-N8NRL-Adapter/{VERSION}"
XML_HEADER = '<?xml version="1.0" encoding="utf-8" ?>'
PROTOCOL_VERSION = "1.0"
SYSTEM_TYPE = "NVMS-9000"

SAFE_COMMANDS = frozenset({
    "reqLogin", "doLogin", "queryBasicCfg", "queryOnlineChlList",
    "queryDevList", "queryChlStatus", "queryRecStatus", "queryPoePower",
    "queryStorageDevInfo", "queryDiskStatus", "queryIPChlInfo",
})
MUTATING_COMMAND_MARKERS = ("edit", "delete", "del", "activate", "reboot", "reset", "upgrade", "format", "initialize")

class SpecoError(RuntimeError):
    pass

class SpecoLoginError(SpecoError):
    def __init__(self, message: str, *, error_code: str | None = None,
                 remaining_attempts: int | None = None,
                 remaining_time_seconds: int | None = None,
                 locked: bool | None = None):
        super().__init__(message)
        self.error_code = error_code
        self.remaining_attempts = remaining_attempts
        self.remaining_time_seconds = remaining_time_seconds
        self.locked = locked

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": "LOGIN_FAILED", "message": str(self),
            "errorCode": self.error_code,
            "remainingAttempts": self.remaining_attempts,
            "remainingTimeSeconds": self.remaining_time_seconds,
            "locked": self.locked,
        }

@dataclass
class Session:
    session_id: str
    token: str
    security_version: str | None = None

def _text(parent: ET.Element | None, path: str) -> str | None:
    if parent is None:
        return None
    value = parent.findtext(path)
    if value is None:
        return None
    value = value.strip()
    return value or None

def _to_int(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None

def _to_float(value: str | None) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None

def _to_bool(value: str | None) -> bool | None:
    if value is None:
        return None
    v = value.strip().lower()
    if v == "true": return True
    if v == "false": return False
    return None

def _channel_number(channel_id: str | None) -> int | None:
    if not channel_id:
        return None
    raw = channel_id.strip()
    if raw.startswith("{") and raw.endswith("}") and len(raw) >= 10:
        try:
            return int(raw[1:9], 16)
        except ValueError:
            return None
    return None

def build_request(
    token: str | None = None,
    inner_xml: str = "",
    *,
    refresh: bool | None = None,
) -> str:
    refresh_attr = ""
    if refresh is not None:
        refresh_attr = f' refresh = "{str(refresh).lower()}"'

    token_xml = "null" if token is None else html.escape(token)

    return (
        XML_HEADER
        + f'<request version="{PROTOCOL_VERSION}"{refresh_attr} '
        + f'systemType="{SYSTEM_TYPE}" clientType="WEB">'
        + f"<token>{token_xml}</token>"
        + inner_xml
        + "</request>"
    )


def compute_login_digest(password: str, nonce: str, rsa_pem: str) -> str:
    md5_hex = hashlib.md5(password.encode("utf-8")).hexdigest().upper()
    normalized_pem = rsa_pem.replace("\r", "")
    return hashlib.sha512(f"{md5_hex}#{nonce}#{normalized_pem}".encode("utf-8")).hexdigest()

def generate_rsa_public_pem() -> str:
    openssl = shutil.which("openssl")

    if not openssl:
        raise SpecoError("openssl is required for Speco login")

    with tempfile.TemporaryDirectory(prefix="psop-speco-rsa-") as directory:
        private_key_path = Path(directory) / "login-private.pem"
        public_key_path = Path(directory) / "login-public.pem"

        generate = subprocess.run(
            [
                openssl,
                "genpkey",
                "-algorithm",
                "RSA",
                "-pkeyopt",
                "rsa_keygen_bits:1024",
                "-out",
                str(private_key_path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        if generate.returncode != 0:
            raise SpecoError(
                "Unable to generate temporary RSA key: "
                + generate.stderr.strip()
            )

        export = subprocess.run(
            [
                openssl,
                "pkey",
                "-in",
                str(private_key_path),
                "-pubout",
                "-out",
                str(public_key_path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        if export.returncode != 0:
            raise SpecoError(
                "Unable to export RSA public key: "
                + export.stderr.strip()
            )

        lines = public_key_path.read_text().splitlines()

        if not lines:
            raise SpecoError("Generated RSA public PEM is empty")

        if lines[0] != "-----BEGIN PUBLIC KEY-----":
            raise SpecoError(
                "Unexpected RSA public key header: " + lines[0]
            )

        if lines[-1] != "-----END PUBLIC KEY-----":
            raise SpecoError(
                "Unexpected RSA public key footer: " + lines[-1]
            )

        return "\r\n".join(lines) + "\r\n"


class SpecoNRLClient:
    def __init__(self, host: str, *, port: int = 80, timeout: float = 5.0,
                 transport: Callable[[str, str], ET.Element] | None = None):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.base_url = f"http://{host}:{port}"
        self.session: Session | None = None
        self._cookie_jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self._cookie_jar))
        self._transport_override = transport

    def _assert_safe(self, command: str) -> None:
        if command not in SAFE_COMMANDS:
            raise SpecoError(f"Command is not in the read-only allowlist: {command}")
        lowered = command.lower()
        if command not in {"reqLogin", "doLogin"} and any(m in lowered for m in MUTATING_COMMAND_MARKERS):
            raise SpecoError(f"Mutating command refused: {command}")

    def _post(self, command: str, xml_body: str) -> ET.Element:
        self._assert_safe(command)
        if self._transport_override is not None:
            return self._transport_override(command, xml_body)
        request = urllib.request.Request(
            f"{self.base_url}/{command}", data=xml_body.encode("utf-8"), method="POST",
            headers={
                "Accept": "application/xml, text/xml, */*; q=0.01",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent": USER_AGENT,
                "X-Requested-With": "XMLHttpRequest",
            },
        )
        if self.session and self.session.session_id:
            request.add_header("Cookie", f"sessionId={self.session.session_id}")
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise SpecoError(f"{command} returned HTTP {error.code}: {detail[:300]}") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise SpecoError(f"{command} failed: {error}") from error
        text = raw.decode("utf-8", errors="replace").replace("\x00", "").strip()
        if not text:
            raise SpecoError(f"{command} returned an empty response")
        try:
            return ET.fromstring(text)
        except ET.ParseError as error:
            raise SpecoError(f"{command} returned invalid XML: {text[:300]}") from error

    def _request(self, command: str, inner_xml: str = "", *, refresh: bool | None = None) -> ET.Element:
        if not self.session:
            raise SpecoError("Speco session is not authenticated")
        root = self._post(command, build_request(self.session.token, inner_xml, refresh=refresh))
        if _text(root, "status") != "success":
            raise SpecoError(f"{command} failed with errorCode={_text(root, 'errorCode')}")
        return root

    def login(self, username: str, password: str) -> Session:
        if not username.strip():
            raise SpecoLoginError("Username is required")
        if len(password) > 16:
            raise SpecoLoginError("Password exceeds the 16-character limit enforced by this firmware")
        req_root = self._post("reqLogin", build_request())
        if _text(req_root, "status") != "success":
            raise SpecoLoginError("reqLogin failed", error_code=_text(req_root, "errorCode"))
        nonce = _text(req_root, "./content/nonce")
        session_id = _text(req_root, "./content/sessionId")
        if not nonce or not session_id:
            raise SpecoLoginError("reqLogin response is missing nonce or sessionId")
        if "{" in session_id or "}" in session_id:
            start, end = session_id.find("{"), session_id.rfind("}")
            if start >= 0 and end > start:
                session_id = session_id[start + 1:end]
        self.session = Session(session_id=session_id, token="")
        rsa_public_pem = generate_rsa_public_pem()
        password_digest = compute_login_digest(password, nonce, rsa_public_pem)
        username_cdata = username.replace("]]>", "]]]]><![CDATA[>")
        inner = ("<content>" + f"<userName><![CDATA[{username_cdata}]]></userName>"
                 + f"<password><![CDATA[{password_digest}]]></password>"
                 + f"<rsaPublic>{html.escape(rsa_public_pem)}</rsaPublic></content>")
        login_root = self._post("doLogin", build_request(None, inner))
        if _text(login_root, "status") != "success":
            err = SpecoLoginError(
                "Speco rejected the login",
                error_code=_text(login_root, "errorCode"),
                remaining_attempts=_to_int(_text(login_root, "ramainingNumber")),
                remaining_time_seconds=_to_int(_text(login_root, "ramainingTime")),
                locked=_to_bool(_text(login_root, "locked")),
            )
            self.session = None
            raise err
        token = _text(login_root, "./content/token")
        if not token:
            self.session = None
            raise SpecoLoginError("doLogin succeeded but returned no token")
        self.session = Session(session_id=session_id, token=token,
                               security_version=_text(login_root, "./content/securityVer"))
        return self.session

    def query_basic_cfg(self) -> dict[str, Any]:
        root = self._request("queryBasicCfg")
        content = root.find("./content")
        return {
            "name": _text(content, "name"),
            "model": _text(content, "model") or _text(content, "deviceModel") or _text(content, "devModel"),
            "hardwareVersion": _text(content, "hardwareVersion"),
            "firmware": _text(content, "softwareVersion"),
            "apiVersion": _text(content, "apiVersion"),
            "onvifVersion": _text(content, "onvifVersion"),
            "onvifDeviceVersion": _text(content, "onvifDevVersion"),
        }

    def query_online_channel_ids(self) -> set[str]:
        root = self._request("queryOnlineChlList", refresh=False)
        return {item.attrib["id"] for item in root.findall("./content/item") if item.attrib.get("id")}

    def query_channel_status(self) -> dict[str, dict[str, Any]]:
        root = self._request("queryChlStatus")
        result = {}
        for item in root.findall("./content/item"):
            chl = item.find("chl")
            channel_id = chl.attrib.get("id") if chl is not None else None
            if channel_id:
                result[channel_id] = {
                    "name": (chl.text or "").strip(),
                    "reportedOnline": _to_bool(_text(item, "online")),
                    "motionStatus": _text(item, "motionStatus"),
                    "intelligentStatus": _text(item, "intelligentStatus"),
                    "recordingStatus": _text(item, "recStatus"),
                }
        return result

    def query_device_list(self) -> list[dict[str, Any]]:
        safe_fields = ("name", "ip", "port", "protocolType", "productModel", "chlIndex", "index", "chlType", "chlNum", "autoReportID", "supportJump", "addType", "poeIndex", "poePort", "manufacturer")
        require = "<requireField>" + "".join(f"<{f}/>" for f in safe_fields) + "</requireField>"
        root = self._request("queryDevList", require)
        devices = []
        for item in root.findall("./content/item"):
            channel_id = item.attrib.get("id")
            model_element = item.find("productModel")
            devices.append({
                "channelId": channel_id,
                "channelNumber": _to_int(_text(item, "chlNum")) or _channel_number(channel_id),
                "name": _text(item, "name"), "ip": _text(item, "ip"),
                "port": _to_int(_text(item, "port")), "protocol": _text(item, "protocolType"),
                "model": ((model_element.text or "").strip() if model_element is not None and model_element.text else None),
                "factoryName": (model_element.attrib.get("factoryName") if model_element is not None else None),
                "manufacturerReported": _text(item, "manufacturer"),
                "addType": _text(item, "addType"), "poeIndex": _to_int(_text(item, "poeIndex")),
                "poePortReported": _to_int(_text(item, "poePort")), "chlIndex": _to_int(_text(item, "chlIndex")),
                "index": _to_int(_text(item, "index")), "chlType": _text(item, "chlType"),
            })
        return devices

    def query_channel_firmware(self, channel_id: str) -> str | None:
        # Recorder-native firmware metadata is optional. Vendor-specific
        # enrichment belongs to child_device_discovery providers.
        root = self._request(
            "queryIPChlInfo",
            (
                "<condition><chlId>"
                + html.escape(channel_id)
                + "</chlId></condition>"
            ),
        )
        return _text(
            root,
            "./content/chl/detailedSoftwareVersion",
        )

    def query_recording_status(self) -> dict[str, list[dict[str, Any]]]:
        root = self._request("queryRecStatus")
        result = {}
        for item in root.findall("./content/item"):
            chl = item.find("chl")
            channel_id = chl.attrib.get("id") if chl is not None else None
            if not channel_id:
                continue
            stream = {
                "name": (chl.text or "").strip(), "resolution": _text(item, "resolution"),
                "frameRate": _to_int(_text(item, "frameRate")), "bitrateKbps": _to_int(_text(item, "quality")),
                "bitType": _text(item, "bitType"), "level": _text(item, "level"),
                "recordingStatus": _text(item, "recStatus"), "streamType": _text(item, "streamType"),
                "recordingTypes": [(c.text or "").strip() for c in item.findall("./recTypes/item") if (c.text or "").strip()],
            }
            result.setdefault(channel_id, []).append(stream)
        return result

    def query_poe_power(self) -> dict[str, Any]:
        root = self._request("queryPoePower")
        content = root.find("./content")
        ports = []
        for ordinal, item in enumerate(root.findall("./content/poePort/item"), start=1):
            raw_index = _to_int(item.attrib.get("index"))
            ports.append({
                "rawIndex": raw_index, "displayPort": raw_index + 1 if raw_index is not None else ordinal,
                "enabled": _to_bool(_text(item, "switch")), "powerW": _to_float(_text(item, "power")),
            })
        return {"totalPowerW": _to_float(_text(content, "totalPower")),
                "remainingPowerW": _to_float(_text(content, "remainPower")), "ports": ports}

    def query_storage(self) -> dict[str, Any]:
        root = self._request("queryStorageDevInfo")
        disks = []
        for item in root.findall("./content/diskList/item"):
            disks.append({
                "id": item.attrib.get("id"), "slotIndex": _to_int(_text(item, "slotIndex")),
                "interfaceType": _text(item, "diskInterfaceType"), "model": _text(item, "model"),
                "sizeRaw": _to_float(_text(item, "size")), "freeSpaceRaw": _to_float(_text(item, "freeSpace")),
            })
        if not disks:
            return {"present": False, "state": "NOT_INSTALLED", "disks": []}
        status_by_id = {}
        try:
            status_root = self._request("queryDiskStatus")
            for item in status_root.findall("./content/item"):
                if item.attrib.get("id"):
                    status_by_id[item.attrib["id"]] = {"status": _text(item, "diskStatus"), "encryptionStatus": _text(item, "diskEncryptStatus")}
        except SpecoError:
            pass
        for disk in disks:
            disk.update(status_by_id.get(str(disk.get("id")), {}))
        return {"present": True, "state": "PRESENT", "disks": disks}

    def collect(self) -> dict[str, Any]:
        errors = []
        optional_gaps = []
        # Track which authenticated CORE recorder calls actually responded.
        # A CORE source returning without raising is positive proof that the
        # recorder is reachable AND the session is still valid. Optional
        # enrichment (queryIPChlInfo, vendor providers) is NEVER proof of
        # reachability and must not move these sets.
        core_succeeded: set[str] = set()
        core_failed: set[str] = set()

        def safe(label, func, fallback):
            try:
                value = func()
            except Exception as error:
                core_failed.add(label)
                errors.append({"source": label, "error": f"{type(error).__name__}: {error}"})
                return fallback
            core_succeeded.add(label)
            return value

        def optional_safe(label, func, fallback):
            try:
                return func()
            except Exception as error:
                optional_gaps.append({
                    "source": label,
                    "error": f"{type(error).__name__}: {error}",
                })
                return fallback
        recorder = safe("queryBasicCfg", self.query_basic_cfg, {})
        online_ids = safe("queryOnlineChlList", self.query_online_channel_ids, None)
        device_rows = safe("queryDevList", self.query_device_list, [])
        status_by_id = safe("queryChlStatus", self.query_channel_status, {})
        recording_by_id = safe("queryRecStatus", self.query_recording_status, {})
        poe = safe("queryPoePower", self.query_poe_power, {"totalPowerW": None, "remainingPowerW": None, "ports": []})
        storage = safe("queryStorageDevInfo", self.query_storage, {"present": None, "state": "UNKNOWN", "disks": []})
        poe_by_raw_index = {p["rawIndex"]: p for p in poe.get("ports", []) if p.get("rawIndex") is not None}
        channels = []
        for row in device_rows:
            channel_id = row.get("channelId")
            if not channel_id:
                continue
            details = status_by_id.get(channel_id, {})
            streams = recording_by_id.get(channel_id, [])
            firmware = optional_safe(
                f"cameraFirmware:{channel_id}",
                lambda cid=channel_id: self.query_channel_firmware(cid),
                None,
            )
            status_source_available = online_ids is not None
            online = (
                channel_id in online_ids
                if status_source_available
                else None
            )
            poe_index = row.get("poeIndex")
            raw_poe_index = poe_index - 1 if isinstance(poe_index, int) and poe_index >= 1 else None
            poe_port = poe_by_raw_index.get(raw_poe_index) if raw_poe_index is not None else None
            primary_stream = streams[0] if streams else {}
            raw_recording_status = details.get("recordingStatus") or primary_stream.get("recordingStatus")
            if storage.get("state") == "NOT_INSTALLED":
                recording_availability = "NOT_AVAILABLE_NO_STORAGE"
            elif raw_recording_status in {"recording", "recordingNormal"}:
                recording_availability = "AVAILABLE"
            elif raw_recording_status:
                recording_availability = "ABNORMAL"
            else:
                recording_availability = "UNKNOWN"
            channels.append({
                **row,
                "verificationMethod": (
                    "RECORDER_CHANNEL_STATUS"
                    if status_source_available
                    else "RECORDER_STATUS_UNAVAILABLE"
                ),
                "individualVerification": (
                    "RECORDER_VERIFIED"
                    if status_source_available
                    else "NOT_VERIFIED"
                ),
                "online": online,
                "operationalState": (
                    ("ONLINE" if online else "OFFLINE")
                    if status_source_available
                    else "UNKNOWN"
                ),
                "reportedOnline": details.get("reportedOnline"), "motionStatus": details.get("motionStatus"),
                "intelligentStatus": details.get("intelligentStatus"), "rawRecordingStatus": raw_recording_status,
                "recordingAvailability": recording_availability, "firmware": firmware,
                "poe": ({"rawIndex": poe_port.get("rawIndex"), "displayPort": poe_port.get("displayPort"),
                         "enabled": poe_port.get("enabled"), "powerW": poe_port.get("powerW")} if poe_port else None),
                "recordingStreams": streams,
            })
        # Rule:
        #   A/B) at least one CORE source responded -> recorderReachable=True
        #        (PASSED when nothing failed, PARTIAL when some did). An ONLINE
        #        heartbeat is allowed.
        #   C)   no CORE source responded           -> recorderReachable=False
        #        collection is diagnostically UNREACHABLE. No new heartbeat.
        recorder_reachable = bool(core_succeeded)
        return {
            "test": "PSOP Speco N8NRL read-only diagnosis", "adapterVersion": VERSION,
            "target": "NVR Speco", "host": self.host, "statusSource": "queryOnlineChlList",
            "physicalSource": "queryPoePower", "observedAtEpoch": int(time.time()),
            "recorder": recorder,
            "statusSourceAvailable": online_ids is not None,
            "onlineChannelIds": (
                sorted(online_ids)
                if online_ids is not None
                else None
            ),
            "channels": channels,
            "poe": poe, "storage": storage, "errors": errors,
            "optionalGaps": optional_gaps,
            "recorderReachable": recorder_reachable,
            "coreSourcesSucceeded": sorted(core_succeeded),
            "coreSourcesFailed": sorted(core_failed),
            "status": (
                "UNREACHABLE"
                if not recorder_reachable
                else "PASSED"
                if not errors
                else "PARTIAL"
            ),
        }



_CHILD_DISCOVERY_ENGINE = ChildDeviceDiscoveryEngine()


def enrich_discovered_children(
    result: dict[str, Any],
    *,
    recorder_host: str,
    local_env: dict[str, str],
    timeout: float,
    engine: ChildDeviceDiscoveryEngine | None = None,
) -> dict[str, Any]:
    """Enrich recorder-discovered children through vendor providers.

    The recorder remains responsible for child discovery and operational
    state. Vendor providers add optional metadata through endpoints the
    recorder itself exposes. Provider failures never downgrade the core
    recorder collection.
    """
    active_engine = engine or _CHILD_DISCOVERY_ENGINE

    username = (
        os.getenv("PSOP_HIKVISION_USERNAME")
        or local_env.get("PSOP_HIKVISION_USERNAME")
    )
    password = (
        os.getenv("PSOP_HIKVISION_PASSWORD")
        or local_env.get("PSOP_HIKVISION_PASSWORD")
    )

    credentials: dict[str, DeviceCredential] = {}
    if username and password:
        credentials["hikvision"] = DeviceCredential(
            username=username,
            password=password,
        )

    channels = result.get("channels")
    if not isinstance(channels, list):
        return result

    summary = {
        "candidates": 0,
        "enriched": 0,
        "credentialRequired": 0,
        "authFailed": 0,
        "noProvider": 0,
        "unreachable": 0,
    }
    enriched_channel_ids: set[str] = set()

    for channel in channels:
        if not isinstance(channel, dict):
            continue

        channel_id = channel.get("channelId")
        proxy_port = channel.get("poePortReported")

        if (
            not isinstance(channel_id, str)
            or not channel_id
            or not isinstance(proxy_port, int)
            or isinstance(proxy_port, bool)
            or not 1 <= proxy_port <= 65535
        ):
            continue

        summary["candidates"] += 1

        endpoint = DiscoveredEndpoint(
            scheme="http",
            host=recorder_host,
            port=proxy_port,
            via="RECORDER_PROXY",
            source="RECORDER_REPORTED_PROXY",
        )
        candidate = DeviceCandidate(
            channel_id=channel_id,
            name=(
                channel.get("name")
                if isinstance(channel.get("name"), str)
                else None
            ),
            model=(
                channel.get("model")
                if isinstance(channel.get("model"), str)
                else None
            ),
            manufacturer=(
                channel.get("manufacturerReported")
                if isinstance(
                    channel.get("manufacturerReported"),
                    str,
                )
                else None
            ),
            protocol=(
                channel.get("protocol")
                if isinstance(channel.get("protocol"), str)
                else None
            ),
            endpoint=endpoint,
        )

        enrichment = active_engine.enrich(
            candidate,
            credentials,
            timeout,
        )

        channel["discovery"] = {
            "endpoint": {
                "scheme": endpoint.scheme,
                "host": endpoint.host,
                "port": endpoint.port,
                "via": endpoint.via,
                "source": endpoint.source,
            },
            **enrichment.public_dict(),
        }

        if enrichment.status == "ENRICHED":
            summary["enriched"] += 1
            enriched_channel_ids.add(channel_id)

            if enrichment.model:
                channel["model"] = enrichment.model

            if enrichment.firmware:
                channel["firmware"] = enrichment.firmware
                channel["firmwareSource"] = (
                    enrichment.source
                    or enrichment.provider
                )

        elif enrichment.status == "CREDENTIAL_REQUIRED":
            summary["credentialRequired"] += 1
        elif enrichment.status == "AUTH_FAILED":
            summary["authFailed"] += 1
        elif enrichment.status == "NO_PROVIDER":
            summary["noProvider"] += 1
        elif enrichment.status == "UNREACHABLE":
            summary["unreachable"] += 1

    optional_gaps = result.get("optionalGaps")
    if (
        isinstance(optional_gaps, list)
        and enriched_channel_ids
    ):
        result["optionalGaps"] = [
            gap
            for gap in optional_gaps
            if not (
                isinstance(gap, dict)
                and isinstance(gap.get("source"), str)
                and any(
                    gap["source"] == f"cameraFirmware:{channel_id}"
                    for channel_id in enriched_channel_ids
                )
            )
        ]

    result["childDiscovery"] = summary
    return result

LOCAL_DIR = Path(__file__).resolve().parent


def resolve_speco_config_dir(
    local_dir: Path, env: dict[str, str] | None = None
) -> Path:
    """Where .env.speco.local / speco.local.json are read from.

    Standalone use: config sits next to the script (`local_dir`), unchanged
    from before this existed. The PSOP lab manager may run this script from
    a separate, code-only runtime directory and point config elsewhere via
    PSOP_SPECO_CONFIG_DIR, so the two are never silently coupled through a
    symlink. A plain function (rather than a module-level constant computed
    directly) so it can be unit-tested with an explicit `env` without
    reloading this module — reloading it would break class identity
    (SpecoError et al.) for every other test module that already imported
    this one in the same process.
    """
    source = os.environ if env is None else env
    return Path(source.get("PSOP_SPECO_CONFIG_DIR", str(local_dir))).expanduser()


CONFIG_DIR = resolve_speco_config_dir(LOCAL_DIR)
DEFAULT_LOCAL_ENV = CONFIG_DIR / ".env.speco.local"
DEFAULT_LOCAL_MAP = CONFIG_DIR / "speco.local.json"


def _load_simple_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values

    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()

        if (
            len(value) >= 2
            and value[0] == value[-1]
            and value[0] in {"'", '"'}
        ):
            value = value[1:-1]

        values[key] = value

    return values


def _load_speco_map(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SpecoError(
            f"PSOP Speco mapping file not found: {path}"
        )

    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise SpecoError(
            f"Unable to read PSOP Speco mapping: {error}"
        ) from error

    if not isinstance(payload, dict):
        raise SpecoError("PSOP Speco mapping must be a JSON object")

    recorder = payload.get("recorder")
    channels = payload.get("channels")

    if (
        not isinstance(recorder, dict)
        or not isinstance(recorder.get("deviceId"), str)
        or not recorder["deviceId"]
    ):
        raise SpecoError(
            "PSOP Speco mapping is missing recorder.deviceId"
        )

    if not isinstance(channels, dict) or not channels:
        raise SpecoError(
            "PSOP Speco mapping is missing channel mappings"
        )

    return payload


class PsopRecorderApiClient:
    def __init__(
        self,
        api_url: str,
        recorder_device_id: str,
        recorder_device_key: str,
        timeout: float,
    ):
        self.api_url = api_url.rstrip("/")
        self.recorder_device_id = recorder_device_id
        self.recorder_device_key = recorder_device_key
        self.timeout = timeout

    def _post(
        self,
        path: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        request = urllib.request.Request(
            f"{self.api_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": f"PSOP-Speco-Adapter/{VERSION}",
                "x-device-id": self.recorder_device_id,
                "x-device-key": self.recorder_device_key,
            },
        )

        try:
            with urllib.request.urlopen(
                request,
                timeout=self.timeout,
            ) as response:
                body = response.read().decode("utf-8")
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as error:
            detail = error.read().decode(
                "utf-8",
                errors="replace",
            )
            raise SpecoError(
                f"PSOP API returned HTTP {error.code}: {detail}"
            ) from error
        except (
            urllib.error.URLError,
            TimeoutError,
            OSError,
        ) as error:
            raise SpecoError(
                f"PSOP API unavailable: {error}"
            ) from error

    def send_recorder(
        self,
        result: dict[str, Any],
    ) -> dict[str, Any]:
        # Defense in depth: this method always emits status="online". If the
        # collection explicitly did not reach the recorder, refuse rather than
        # renew the heartbeat with stale/empty data. The caller
        # (run_psop_once) is expected to skip this entirely.
        if result.get("recorderReachable") is False:
            raise SpecoError(
                "Refusing to emit an ONLINE recorder heartbeat: the "
                "collection did not reach the recorder "
                "(recorderReachable=False)"
            )

        recorder = result.get("recorder")
        if not isinstance(recorder, dict):
            recorder = {}

        storage = result.get("storage")
        if not isinstance(storage, dict):
            storage = {}

        poe = result.get("poe")
        if not isinstance(poe, dict):
            poe = {}

        channels = result.get("channels")
        if not isinstance(channels, list):
            channels = []

        online_ids = result.get("onlineChannelIds")
        if not isinstance(online_ids, list):
            online_ids = None

        total_power = poe.get("totalPowerW")
        remaining_power = poe.get("remainingPowerW")
        used_power = None
        if (
            isinstance(total_power, (int, float))
            and not isinstance(total_power, bool)
            and isinstance(remaining_power, (int, float))
            and not isinstance(remaining_power, bool)
        ):
            used_power = max(
                0.0,
                float(total_power) - float(remaining_power),
            )

        disks = storage.get("disks")
        disk_count = len(disks) if isinstance(disks, list) else None

        def first_text(*keys: str) -> str | None:
            for key in keys:
                value = recorder.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
            return None

        details: dict[str, Any] = {
            "storageState": storage.get("state"),
            "storagePresent": storage.get("present"),
            "diskCount": disk_count,
            "poeTotalPowerW": total_power,
            "poeRemainingPowerW": remaining_power,
            "poeUsedPowerW": used_power,
            "onlineChannelCount": (
                len(online_ids)
                if online_ids is not None
                else None
            ),
            "observedChannelCount": len(channels),
            "hardwareVersion": first_text(
                "hardwareVersion",
                "hardware",
                "hardWareVersion",
            ),
            "apiVersion": first_text(
                "apiVersion",
                "api",
            ),
            "onvifVersion": first_text(
                "onvifVersion",
                "onvif",
            ),
            "onvifDeviceVersion": first_text(
                "onvifDeviceVersion",
                "onvifDevVersion",
            ),
            "kernelVersion": first_text(
                "kernelVersion",
                "kenerlVersion",
            ),
            "mcuVersion": first_text(
                "mcuVersion",
                "mcu",
            ),
        }

        # Whitelist only operational metadata. Do not send serial numbers,
        # credentials, tokens or arbitrary raw recorder objects.
        details = {
            key: value
            for key, value in details.items()
            if value is not None
        }

        errors = result.get("errors")
        errors = errors if isinstance(errors, list) else []
        optional_gaps = result.get("optionalGaps")
        optional_gaps = (
            optional_gaps if isinstance(optional_gaps, list) else []
        )

        collection_issues: list[dict[str, Any]] = []
        for entry in errors:
            if isinstance(entry, dict):
                collection_issues.append(
                    {
                        "code": "COLLECTION_SOURCE_FAILED",
                        "source": "ADAPTER",
                        "detail": (
                            f"{entry.get('source')}: {entry.get('error')}"
                        )[:500],
                    }
                )
        for entry in optional_gaps:
            if isinstance(entry, dict):
                collection_issues.append(
                    {
                        "code": "OPTIONAL_ENRICHMENT_UNAVAILABLE",
                        "source": "ADAPTER",
                        "detail": (
                            f"{entry.get('source')}: {entry.get('error')}"
                        )[:500],
                    }
                )

        # `COMPLETE` only when every expected source responded. A failed core
        # source (`errors`) or an unavailable optional enrichment
        # (`optional_gaps`) both mean the collection was only `PARTIAL`. An
        # optional gap is never a core failure, so this never becomes `FAILED`:
        # the recorder stays `online` and connectivity/health are untouched.
        collection_state = (
            "COMPLETE" if not errors and not optional_gaps else "PARTIAL"
        )

        storage_state = storage.get("state")
        storage_present = bool(storage.get("present"))
        capabilities = {
            "storage": {
                "supported": True,
                "present": storage_present,
                "state": (
                    storage_state
                    if storage_state
                    in {"PRESENT", "NOT_INSTALLED", "UNKNOWN"}
                    else "UNKNOWN"
                ),
            },
            "recording": {
                "state": (
                    "NOT_AVAILABLE_NO_STORAGE"
                    if storage_state == "NOT_INSTALLED"
                    else "UNKNOWN"
                ),
            },
        }

        payload: dict[str, Any] = {
            "timestamp": int(result["observedAtEpoch"]),
            # Connectivity/health for the recorder itself: it stays "online"
            # whenever authentication + core collection confirmed the device.
            # Collection-quality gaps (a failed optional source, missing
            # firmware enrichment) NEVER degrade the recorder here — they are
            # reported through `collectionState` / `collectionIssues` instead.
            "status": "online",
            "collectionState": collection_state,
            "collectionIssues": collection_issues,
            "capabilities": capabilities,
            "details": details,
        }

        model = first_text("model", "productModel")
        firmware = first_text("firmware", "softwareVersion")

        if model:
            payload["model"] = model

        if firmware:
            payload["firmware"] = firmware

        return self._post("/telemetry/ingest", payload)

    def send_observations(
        self,
        timestamp: int,
        observations: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if not observations:
            raise SpecoError(
                "Refusing to send an empty recorder observation batch"
            )

        return self._post(
            "/telemetry/recorder-observations",
            {
                "timestamp": int(timestamp),
                "observations": observations,
            },
        )


def build_psop_recorder_observations(
    result: dict[str, Any],
    mapping: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[str]]:
    if result.get("statusSourceAvailable") is not True:
        return [], []

    mapped_channels = mapping.get("channels")
    if not isinstance(mapped_channels, dict):
        raise SpecoError(
            "PSOP Speco mapping channels are invalid"
        )

    observations: list[dict[str, Any]] = []
    unmapped: list[str] = []
    collected_channel_ids: set[str] = set()

    online_channel_ids = result.get("onlineChannelIds")
    if not isinstance(online_channel_ids, list):
        raise SpecoError(
            "Authoritative online channel list is unavailable"
        )
    online_set = {
        channel_id
        for channel_id in online_channel_ids
        if isinstance(channel_id, str)
    }

    channels = result.get("channels")
    if not isinstance(channels, list):
        raise SpecoError(
            "Speco collection channels are invalid"
        )

    for channel in channels:
        if not isinstance(channel, dict):
            continue

        channel_id = channel.get("channelId")
        if not isinstance(channel_id, str) or not channel_id:
            continue

        collected_channel_ids.add(channel_id)

        mapped = mapped_channels.get(channel_id)
        if not isinstance(mapped, dict):
            unmapped.append(channel_id)
            continue

        device_id = mapped.get("deviceId")
        if not isinstance(device_id, str) or not device_id:
            raise SpecoError(
                f"Missing PSOP deviceId mapping for {channel_id}"
            )

        verification = channel.get("individualVerification")
        state = channel.get("operationalState")

        if verification != "RECORDER_VERIFIED":
            continue

        if state == "ONLINE":
            status = "online"
        elif state == "OFFLINE":
            status = "offline"
        else:
            continue

        observation: dict[str, Any] = {
            "deviceId": device_id,
            "status": status,
            "channelId": channel_id,
        }

        channel_number = channel.get("channelNumber")
        if isinstance(channel_number, int) and channel_number >= 1:
            observation["channelNumber"] = channel_number

        poe = channel.get("poe")
        if isinstance(poe, dict):
            display_port = poe.get("displayPort")
            power_w = poe.get("powerW")

            if isinstance(display_port, int) and display_port >= 1:
                observation["poePort"] = display_port

            if (
                isinstance(power_w, (int, float))
                and not isinstance(power_w, bool)
                and power_w >= 0
            ):
                observation["poePowerW"] = float(power_w)

        recording = channel.get("recordingAvailability")
        if isinstance(recording, str) and recording:
            observation["recordingStatus"] = recording

        protocol = channel.get("protocol")
        if isinstance(protocol, str) and protocol:
            observation["protocol"] = protocol

        model = channel.get("model")
        if isinstance(model, str) and model:
            observation["model"] = model

        firmware = channel.get("firmware")
        if isinstance(firmware, str) and firmware:
            observation["firmware"] = firmware

        streams = channel.get("recordingStreams")
        if isinstance(streams, list) and streams:
            main_stream = next(
                (
                    stream
                    for stream in streams
                    if isinstance(stream, dict)
                    and stream.get("streamType") == "main"
                ),
                None,
            )
            if main_stream is None:
                main_stream = next(
                    (
                        stream
                        for stream in streams
                        if isinstance(stream, dict)
                    ),
                    None,
                )

            if isinstance(main_stream, dict):
                bitrate = main_stream.get("bitrateKbps")
                resolution = main_stream.get("resolution")
                frame_rate = main_stream.get("frameRate")

                if isinstance(bitrate, int) and bitrate >= 0:
                    observation["bitrateKbps"] = bitrate

                if isinstance(resolution, str) and resolution:
                    observation["resolution"] = resolution

                if isinstance(frame_rate, int) and frame_rate >= 0:
                    observation["frameRate"] = frame_rate

        observations.append(observation)

    # An unplugged Speco PoE camera can disappear from queryDevList.
    # The authoritative queryOnlineChlList still tells us whether an
    # expected mapped channel is online. Therefore an expected mapped
    # channel absent from queryDevList must not merely age into UNKNOWN:
    # if it is absent from the authoritative online set, that is an
    # explicit recorder-verified OFFLINE observation.
    poe = result.get("poe")
    poe_ports = (
        poe.get("ports", [])
        if isinstance(poe, dict)
        else []
    )

    for channel_id, mapped in mapped_channels.items():
        if channel_id in collected_channel_ids:
            continue

        if not isinstance(mapped, dict):
            continue

        device_id = mapped.get("deviceId")
        if not isinstance(device_id, str) or not device_id:
            raise SpecoError(
                f"Missing PSOP deviceId mapping for {channel_id}"
            )

        status = (
            "online"
            if channel_id in online_set
            else "offline"
        )

        synthetic: dict[str, Any] = {
            "deviceId": device_id,
            "status": status,
            "channelId": channel_id,
        }

        channel_number = mapped.get("channelNumber")
        if isinstance(channel_number, int) and channel_number >= 1:
            synthetic["channelNumber"] = channel_number
            synthetic["poePort"] = channel_number

            matching_poe = next(
                (
                    port
                    for port in poe_ports
                    if isinstance(port, dict)
                    and port.get("displayPort") == channel_number
                ),
                None,
            )
            if isinstance(matching_poe, dict):
                power_w = matching_poe.get("powerW")
                if (
                    isinstance(power_w, (int, float))
                    and not isinstance(power_w, bool)
                    and power_w >= 0
                ):
                    synthetic["poePowerW"] = float(power_w)

        observations.append(synthetic)

    return observations, unmapped


def run_psop_once(
    result: dict[str, Any],
    api: PsopRecorderApiClient,
    mapping: dict[str, Any],
) -> dict[str, Any]:
    if result.get("recorderReachable") is False:
        # The collection never reached the recorder. Telemetry that old must
        # not renew the heartbeat: send nothing and let the last real
        # heartbeat age out. Health Engine V2 then concludes
        # HEARTBEAT_OVERDUE -> linkState OFFLINE on its own. Children behind
        # this recorder receive no assertion and age into UNKNOWN.
        return {
            "recorderDelivered": False,
            "childDelivery": "SKIPPED_RECORDER_UNREACHABLE",
            "observationsSent": 0,
            "unmappedChannels": [],
        }

    recorder_response = api.send_recorder(result)

    observations, unmapped = build_psop_recorder_observations(
        result,
        mapping,
    )

    if result.get("statusSourceAvailable") is not True:
        return {
            "recorderDelivered": True,
            "childDelivery": "SKIPPED_STATUS_SOURCE_UNAVAILABLE",
            "observationsSent": 0,
            "unmappedChannels": unmapped,
            "recorderResponse": recorder_response,
        }

    if not observations:
        return {
            "recorderDelivered": True,
            "childDelivery": "SKIPPED_NO_VERIFIED_OBSERVATIONS",
            "observationsSent": 0,
            "unmappedChannels": unmapped,
            "recorderResponse": recorder_response,
        }

    child_response = api.send_observations(
        int(result["observedAtEpoch"]),
        observations,
    )

    return {
        "recorderDelivered": True,
        "childDelivery": "DELIVERED",
        "observationsSent": len(observations),
        "unmappedChannels": unmapped,
        "recorderResponse": recorder_response,
        "childResponse": child_response,
    }


def _attempt_relogin(
    client: SpecoNRLClient,
    username: str | None,
    password: str | None,
) -> str:
    """One controlled re-authentication attempt.

    Never loops and never logs credentials. Called at most once per --watch
    tick, only when the tick found the recorder unreachable, so a rebooted
    NVR can be picked up again without an aggressive login loop.
    """
    if not username or not password:
        return "RELOGIN_SKIPPED_NO_CREDENTIALS"
    try:
        client.login(username, password)
    except SpecoLoginError:
        return "RELOGIN_AUTH_FAILED"
    except SpecoError:
        return "RELOGIN_UNREACHABLE"
    return "RELOGIN_OK"


def _collect_and_enrich(
    client: SpecoNRLClient,
    *,
    recorder_host: str,
    local_env: dict[str, str],
    timeout: float,
) -> dict[str, Any]:
    return enrich_discovered_children(
        client.collect(),
        recorder_host=recorder_host,
        local_env=local_env,
        timeout=timeout,
    )


def watch_tick(
    client: SpecoNRLClient,
    api: PsopRecorderApiClient,
    mapping: dict[str, Any],
    *,
    recorder_host: str,
    local_env: dict[str, str],
    timeout: float,
    credentials: tuple[str | None, str | None],
    collect_fn: Callable[..., dict[str, Any]] = _collect_and_enrich,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Run exactly one --watch iteration.

    Order is strict: collect NOW -> enrich -> (at most one re-auth if the
    recorder looks unreachable) -> deliver ONLY this tick's collection. A
    previous tick's result is never reused as the current heartbeat.
    """
    username, password = credentials

    result = collect_fn(
        client,
        recorder_host=recorder_host,
        local_env=local_env,
        timeout=timeout,
    )

    reauth_outcome: str | None = None
    if result.get("recorderReachable") is False:
        # No CORE source responded this tick. It could be a dead NVR or a
        # stale session after a reboot. Try to re-authenticate exactly once;
        # if that succeeds, re-collect once so a recovered recorder resumes
        # its real heartbeat within the same tick. If it fails, we still send
        # nothing and try again on the next tick.
        reauth_outcome = _attempt_relogin(client, username, password)
        if reauth_outcome == "RELOGIN_OK":
            result = collect_fn(
                client,
                recorder_host=recorder_host,
                local_env=local_env,
                timeout=timeout,
            )

    delivery = run_psop_once(result, api, mapping)
    if reauth_outcome is not None:
        delivery["reauth"] = reauth_outcome
    return result, delivery


def _log_line(*parts: object) -> None:
    """Print one --watch progress line, flushed immediately.

    The watcher runs detached with stdout redirected to a log file, where the
    default block buffering would hide tick output for many minutes. Flushing
    per line keeps the log usable for live observability.
    """
    print(*parts, flush=True)


def _startup_login(
    client: SpecoNRLClient,
    username: str,
    password: str,
    *,
    watch: bool,
) -> dict[str, Any] | None:
    """Authenticate once before entering a run mode.

    Returns None on success. On failure returns a small dict describing the
    outcome ({"fatal": bool, "status": str, "code": int | None, ...}).

    For --watch, a recorder that cannot be reached at all (SpecoError, e.g.
    the NVR is already powered off at startup) is NOT fatal: the loop starts
    anyway and watch_tick re-authenticates at most once per cycle, so the
    recorder is picked up automatically when it comes back. A recorder that
    actively rejects the credentials (SpecoLoginError) is always fatal.

    Never logs or echoes the password.
    """
    try:
        client.login(username, password)
        return None
    except SpecoLoginError as error:
        return {
            "fatal": True,
            "status": "LOGIN_FAILED",
            "login": error.to_dict(),
            "code": 5,
        }
    except SpecoError as error:
        if watch:
            return {
                "fatal": False,
                "status": "RECORDER_UNREACHABLE_AT_STARTUP",
                "error": str(error),
                "code": None,
            }
        return {
            "fatal": True,
            "status": "ERROR",
            "error": str(error),
            "code": 6,
        }


def run_watch_loop(
    client: SpecoNRLClient,
    api: PsopRecorderApiClient,
    mapping: dict[str, Any],
    *,
    recorder_host: str,
    local_env: dict[str, str],
    timeout: float,
    credentials: tuple[str | None, str | None],
    interval: float,
    collect_fn: Callable[..., dict[str, Any]] = _collect_and_enrich,
    sleep_fn: Callable[[float], None] = time.sleep,
    log_fn: Callable[..., None] = _log_line,
    max_ticks: int | None = None,
) -> int:
    """Drive the --watch loop.

    Each iteration is a self-contained watch_tick: collect NOW, re-auth at
    most once if the recorder looks unreachable, deliver only this tick's
    data. The loop never exits on a network error or an unreachable recorder;
    only KeyboardInterrupt (or max_ticks, used by tests) stops it.
    """
    tick = 0
    try:
        while max_ticks is None or tick < max_ticks:
            tick += 1
            result, delivery = watch_tick(
                client,
                api,
                mapping,
                recorder_host=recorder_host,
                local_env=local_env,
                timeout=timeout,
                credentials=credentials,
                collect_fn=collect_fn,
            )

            reauth = delivery.get("reauth")
            log_fn(
                "Speco "
                f"collection={result['status']} "
                f"reachable={result.get('recorderReachable')} "
                f"children={delivery['observationsSent']} "
                f"delivery={delivery['childDelivery']}"
                + (f" reauth={reauth}" if reauth else "")
            )

            if max_ticks is not None and tick >= max_ticks:
                break
            sleep_fn(interval)
    except KeyboardInterrupt:
        log_fn("\nSpeco watch encerrado.")
    return 0


def main() -> int:
    local_env = _load_simple_env(DEFAULT_LOCAL_ENV)

    parser = argparse.ArgumentParser(
        description="Read-only Speco N8NRL adapter for PSOP"
    )
    parser.add_argument(
        "--host",
        default=local_env.get("PSOP_SPECO_HOST"),
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(
            local_env.get("PSOP_SPECO_PORT", "80")
        ),
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=5.0,
    )
    parser.add_argument(
        "--username",
        default=local_env.get("PSOP_SPECO_USERNAME"),
    )

    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--diagnose", action="store_true")
    mode.add_argument("--once", action="store_true")
    mode.add_argument("--watch", action="store_true")

    parser.add_argument(
        "--interval",
        type=float,
        default=30.0,
        help="Polling interval in seconds for --watch",
    )
    parser.add_argument("--json", action="store_true")
    parser.add_argument(
        "--version",
        action="version",
        version=VERSION,
    )
    args = parser.parse_args()

    if not args.host:
        parser.error(
            "--host is required unless PSOP_SPECO_HOST "
            "exists in .env.speco.local"
        )

    username = args.username or input("Speco username: ").strip()
    # Allow a runtime-only password (e.g. sourced from the macOS Keychain by
    # the local lab manager). It is read from the environment and never logged
    # or persisted; interactive use still falls back to a getpass prompt.
    password = os.environ.get("PSOP_SPECO_PASSWORD") or getpass.getpass(
        "Speco password: "
    )

    client = SpecoNRLClient(
        args.host,
        port=args.port,
        timeout=max(0.5, args.timeout),
    )

    login_outcome = _startup_login(
        client, username, password, watch=args.watch
    )
    if login_outcome is not None and login_outcome["fatal"]:
        payload = {
            "test": "PSOP Speco N8NRL read-only adapter",
            "target": "NVR Speco",
            "host": args.host,
            "status": login_outcome["status"],
        }
        if "login" in login_outcome:
            payload["login"] = login_outcome["login"]
        if "error" in login_outcome:
            payload["error"] = login_outcome["error"]
        print(json.dumps(payload, indent=2, sort_keys=True))
        return login_outcome["code"]
    if login_outcome is not None:
        # --watch only: the recorder is unreachable right now. Enter the loop
        # anyway; watch_tick re-authenticates at most once per cycle and real
        # collection resumes automatically when the recorder returns.
        _log_line(
            "Speco login inicial falhou: recorder inacessivel. "
            "--watch permanece ativo e vai reautenticar uma vez por ciclo."
        )

    if not args.watch:
        result = enrich_discovered_children(
            client.collect(),
            recorder_host=args.host,
            local_env=local_env,
            timeout=max(0.5, args.timeout),
        )

    if args.diagnose:
        print(
            json.dumps(
                result,
                indent=2,
                sort_keys=True,
            )
            if args.json
            else (
                f"NVR Speco status={result['status']} "
                f"channels={len(result['channels'])}"
            )
        )
        return 0 if result["status"] == "PASSED" else 4

    try:
        mapping = _load_speco_map(DEFAULT_LOCAL_MAP)

        recorder_mapping = mapping["recorder"]
        recorder_device_id = recorder_mapping["deviceId"]

        configured_id = local_env.get(
            "PSOP_SPECO_RECORDER_DEVICE_ID"
        )
        if configured_id and configured_id != recorder_device_id:
            raise SpecoError(
                "Recorder device ID differs between "
                ".env.speco.local and speco.local.json"
            )

        api_url = local_env.get("PSOP_API_URL")
        recorder_key = local_env.get(
            "PSOP_SPECO_RECORDER_DEVICE_KEY"
        )

        if not api_url:
            raise SpecoError(
                "PSOP_API_URL is missing from .env.speco.local"
            )

        if not recorder_key:
            raise SpecoError(
                "PSOP_SPECO_RECORDER_DEVICE_KEY is missing "
                "from .env.speco.local"
            )

        api = PsopRecorderApiClient(
            api_url,
            recorder_device_id,
            recorder_key,
            max(0.5, args.timeout),
        )

        if args.watch:
            interval = max(5.0, args.interval)
            _log_line(
                f"Speco watch ativo a cada {interval:g}s "
                "(Ctrl+C para parar)"
            )
            return run_watch_loop(
                client,
                api,
                mapping,
                recorder_host=args.host,
                local_env=local_env,
                timeout=max(0.5, args.timeout),
                credentials=(username, password),
                interval=interval,
            )

        delivery = run_psop_once(
            result,
            api,
            mapping,
        )
    except SpecoError as error:
        print(
            json.dumps(
                {
                    "test": "PSOP Speco N8NRL one-shot delivery",
                    "target": "NVR Speco",
                    "host": args.host,
                    "status": "DELIVERY_ERROR",
                    "error": str(error),
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 7

    summary = {
        "test": "PSOP Speco N8NRL one-shot delivery",
        "target": "NVR Speco",
        "host": args.host,
        "collectionStatus": result["status"],
        "statusSourceAvailable": result.get(
            "statusSourceAvailable"
        ),
        "optionalGaps": result.get("optionalGaps", []),
        "errors": result.get("errors", []),
        "delivery": {
            key: value
            for key, value in delivery.items()
            if key not in {
                "recorderResponse",
                "childResponse",
            }
        },
        "status": (
            "DELIVERED"
            if delivery["recorderDelivered"]
            else "ERROR"
        ),
    }

    print(
        json.dumps(summary, indent=2, sort_keys=True)
        if args.json
        else (
            "NVR Speco delivered="
            f"{delivery['recorderDelivered']} "
            "childDelivery="
            f"{delivery['childDelivery']} "
            "observations="
            f"{delivery['observationsSent']}"
        )
    )

    if not delivery["recorderDelivered"]:
        # --once against an unreachable recorder: no heartbeat was sent.
        return 7

    if delivery.get("unmappedChannels"):
        return 8

    return 0

if __name__ == "__main__":
    raise SystemExit(main())
