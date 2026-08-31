from __future__ import annotations

import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class DeviceCredential:
    username: str
    password: str


@dataclass(frozen=True)
class DiscoveredEndpoint:
    scheme: str
    host: str
    port: int
    via: str
    source: str

    @property
    def base_url(self) -> str:
        return f"{self.scheme}://{self.host}:{self.port}"


@dataclass(frozen=True)
class DeviceCandidate:
    channel_id: str
    name: str | None
    model: str | None
    manufacturer: str | None
    protocol: str | None
    endpoint: DiscoveredEndpoint


@dataclass(frozen=True)
class DeviceEnrichmentResult:
    provider: str | None
    status: str
    capabilities: tuple[str, ...] = ()
    model: str | None = None
    firmware: str | None = None
    hardware_version: str | None = None
    source: str | None = None
    error_code: str | None = None

    def public_dict(self) -> dict[str, object]:
        result: dict[str, object] = {
            "provider": self.provider,
            "status": self.status,
            "capabilities": list(self.capabilities),
        }
        if self.source:
            result["source"] = self.source
        if self.error_code:
            result["errorCode"] = self.error_code
        if self.hardware_version:
            result["hardwareVersion"] = self.hardware_version
        return result


XmlFetcher = Callable[
    [str, DeviceCredential, float],
    bytes,
]


def _xml_value(root: ET.Element, local_name: str) -> str | None:
    for element in root.iter():
        name = element.tag.rsplit("}", 1)[-1]
        if name != local_name:
            continue
        value = (element.text or "").strip()
        return value or None
    return None


def _digest_fetch(
    url: str,
    credential: DeviceCredential,
    timeout: float,
) -> bytes:
    parsed = urllib.parse.urlsplit(url)
    root_url = (
        f"{parsed.scheme}://{parsed.hostname}"
        + (
            f":{parsed.port}"
            if parsed.port is not None
            else ""
        )
        + "/"
    )

    manager = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    manager.add_password(
        None,
        root_url,
        credential.username,
        credential.password,
    )

    opener = urllib.request.build_opener(
        urllib.request.HTTPDigestAuthHandler(manager)
    )

    request = urllib.request.Request(
        url,
        method="GET",
        headers={
            "Accept": "application/xml, text/xml, */*",
            "User-Agent": "PSOP-Child-Discovery/0.1",
        },
    )

    with opener.open(
        request,
        timeout=max(0.5, timeout),
    ) as response:
        return response.read()


class HikvisionIsapiProvider:
    name = "HIKVISION_ISAPI"
    credential_key = "hikvision"

    def __init__(
        self,
        fetcher: XmlFetcher | None = None,
    ):
        self._fetcher = fetcher or _digest_fetch

    def matches(self, candidate: DeviceCandidate) -> bool:
        model = (candidate.model or "").strip().upper()
        text = " ".join(
            part
            for part in (
                candidate.name,
                candidate.manufacturer,
            )
            if isinstance(part, str)
        ).lower()

        return (
            "hikvision" in text
            or model.startswith("DS-")
            or model.startswith("IDS-")
        )

    def enrich(
        self,
        candidate: DeviceCandidate,
        credential: DeviceCredential | None,
        timeout: float,
    ) -> DeviceEnrichmentResult:
        if credential is None:
            return DeviceEnrichmentResult(
                provider=self.name,
                status="CREDENTIAL_REQUIRED",
                source="RECORDER_PROXY",
            )

        url = (
            candidate.endpoint.base_url
            + "/ISAPI/System/deviceInfo"
        )

        try:
            payload = self._fetcher(
                url,
                credential,
                timeout,
            )
        except urllib.error.HTTPError as error:
            if error.code == 401:
                return DeviceEnrichmentResult(
                    provider=self.name,
                    status="AUTH_FAILED",
                    source="HIKVISION_ISAPI",
                    error_code="HTTP_401",
                )
            return DeviceEnrichmentResult(
                provider=self.name,
                status="HTTP_ERROR",
                source="HIKVISION_ISAPI",
                error_code=f"HTTP_{error.code}",
            )
        except (
            urllib.error.URLError,
            TimeoutError,
            OSError,
        ):
            return DeviceEnrichmentResult(
                provider=self.name,
                status="UNREACHABLE",
                source="HIKVISION_ISAPI",
                error_code="NETWORK_ERROR",
            )

        try:
            root = ET.fromstring(payload)
        except ET.ParseError:
            return DeviceEnrichmentResult(
                provider=self.name,
                status="INVALID_RESPONSE",
                source="HIKVISION_ISAPI",
                error_code="INVALID_XML",
            )

        model = _xml_value(root, "model")
        firmware_version = _xml_value(
            root,
            "firmwareVersion",
        )
        firmware_release = _xml_value(
            root,
            "firmwareReleasedDate",
        )
        hardware_version = _xml_value(
            root,
            "hardwareVersion",
        )

        firmware_parts = [
            value
            for value in (
                firmware_version,
                firmware_release,
            )
            if value
        ]
        firmware = (
            " ".join(firmware_parts)
            if firmware_parts
            else None
        )

        capabilities = ["DEVICE_INFO"]
        if firmware:
            capabilities.append("FIRMWARE_VERSION")

        return DeviceEnrichmentResult(
            provider=self.name,
            status="ENRICHED",
            capabilities=tuple(capabilities),
            model=model,
            firmware=firmware,
            hardware_version=hardware_version,
            source="HIKVISION_ISAPI",
        )


class ChildDeviceDiscoveryEngine:
    def __init__(
        self,
        providers: list[object] | None = None,
        *,
        success_ttl_seconds: float = 900.0,
        failure_ttl_seconds: float = 300.0,
    ):
        self.providers = providers or [
            HikvisionIsapiProvider(),
        ]
        self.success_ttl_seconds = max(
            1.0,
            success_ttl_seconds,
        )
        self.failure_ttl_seconds = max(
            1.0,
            failure_ttl_seconds,
        )
        self._cache: dict[
            tuple[str, str, int, str, str],
            tuple[float, DeviceEnrichmentResult],
        ] = {}

    def enrich(
        self,
        candidate: DeviceCandidate,
        credentials: dict[str, DeviceCredential],
        timeout: float,
    ) -> DeviceEnrichmentResult:
        provider = next(
            (
                item
                for item in self.providers
                if item.matches(candidate)
            ),
            None,
        )

        if provider is None:
            return DeviceEnrichmentResult(
                provider=None,
                status="NO_PROVIDER",
                source="RECORDER_PROXY",
            )

        credential = credentials.get(
            provider.credential_key
        )
        username = (
            credential.username
            if credential is not None
            else ""
        )

        cache_key = (
            candidate.channel_id,
            candidate.endpoint.host,
            candidate.endpoint.port,
            provider.name,
            username,
        )
        now = time.monotonic()
        cached = self._cache.get(cache_key)

        if cached is not None:
            expires_at, result = cached
            if now < expires_at:
                return result
            self._cache.pop(cache_key, None)

        result = provider.enrich(
            candidate,
            credential,
            timeout,
        )

        ttl = (
            self.success_ttl_seconds
            if result.status == "ENRICHED"
            else self.failure_ttl_seconds
        )
        self._cache[cache_key] = (
            now + ttl,
            result,
        )
        return result
