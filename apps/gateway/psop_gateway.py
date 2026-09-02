#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import platform
import re
import subprocess
import sqlite3
import ssl
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

VERSION = "1.3.0"
USER_AGENT = f"PSOP-Edge-Gateway/{VERSION}"


@dataclass(frozen=True)
class ProbeConfig:
    name: str
    probe_type: str
    host: str
    port: int = 0
    path: str = "/"
    required: bool = True
    verify_tls: bool = False
    expected_mac: str | None = None


@dataclass(frozen=True)
class GatewayConfig:
    api_url: str
    device_id: str
    external_id: str
    interval_seconds: int
    timeout_seconds: float
    model: str | None
    firmware: str | None
    spool_path: Path
    probes: tuple[ProbeConfig, ...]


@dataclass(frozen=True)
class ProbeResult:
    name: str
    probe_type: str
    host: str
    port: int
    required: bool
    success: bool
    latency_ms: int
    detail: str


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_config(path: Path) -> GatewayConfig:
    raw = json.loads(path.read_text())
    target = raw.get("target") or {}
    host = str(target.get("host") or "").strip()
    for field in ("apiUrl", "deviceId", "externalId"):
        if not raw.get(field):
            raise ValueError(f"{field} is required")
    if not host:
        raise ValueError("target.host is required")
    rows = raw.get("probes") or []
    if not rows:
        raise ValueError("At least one probe is required")
    probes = []
    for index, item in enumerate(rows, start=1):
        probe_type = str(item.get("type") or "tcp").lower()
        if probe_type not in {"tcp", "http", "https", "rtsp", "icmp"}:
            raise ValueError(f"Unsupported probe type: {probe_type}")

        port = int(item.get("port") or 0)
        if probe_type != "icmp" and not 1 <= port <= 65535:
            raise ValueError(f"Invalid probe port at index {index}")

        expected_mac_raw = item.get("expectedMac")
        expected_mac = (
            str(expected_mac_raw).strip().lower()
            if expected_mac_raw
            else None
        )

        probes.append(
            ProbeConfig(
                name=str(item.get("name") or f"probe-{index}"),
                probe_type=probe_type,
                host=str(item.get("host") or host),
                port=port,
                path=str(item.get("path") or "/"),
                required=bool(item.get("required", True)),
                verify_tls=bool(item.get("verifyTls", False)),
                expected_mac=expected_mac,
            )
        )
    spool = Path(raw.get("spoolPath") or "apps/gateway/state/pending.db")
    if not spool.is_absolute():
        spool = (path.parent.parent.parent / spool).resolve()
    return GatewayConfig(
        api_url=str(raw["apiUrl"]).rstrip("/"),
        device_id=str(raw["deviceId"]),
        external_id=str(raw["externalId"]),
        interval_seconds=max(5, int(raw.get("intervalSeconds", 30))),
        timeout_seconds=max(0.2, float(raw.get("timeoutSeconds", 3))),
        model=str(raw["model"]) if raw.get("model") is not None else None,
        firmware=str(raw["firmware"]) if raw.get("firmware") is not None else None,
        spool_path=spool,
        probes=tuple(probes),
    )


def elapsed_ms(start: float) -> int:
    return max(0, round((time.perf_counter() - start) * 1000))



def normalize_mac(value: str | None) -> str | None:
    if not value:
        return None

    chunks = re.findall(r"[0-9a-fA-F]{1,2}", value)
    if len(chunks) != 6:
        return None

    return ":".join(chunk.zfill(2).lower() for chunk in chunks)


def resolve_neighbor_mac(host: str, timeout: float) -> str | None:
    commands: list[list[str]] = []

    if platform.system() == "Darwin":
        commands.append(["arp", "-n", host])
    else:
        commands.extend(
            [
                ["ip", "neigh", "show", host],
                ["arp", "-n", host],
            ]
        )

    for command in commands:
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=max(0.5, timeout),
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue

        text = (completed.stdout or "") + "\n" + (completed.stderr or "")
        match = re.search(
            r"\b([0-9a-fA-F]{1,2}(?::[0-9a-fA-F]{1,2}){5})\b",
            text,
        )
        if match:
            return normalize_mac(match.group(1))

    return None


def probe_icmp(config: ProbeConfig, timeout: float) -> ProbeResult:
    start = time.perf_counter()
    wait_seconds = max(1, round(timeout))

    if platform.system() == "Darwin":
        command = [
            "ping",
            "-c",
            "1",
            "-W",
            str(wait_seconds * 1000),
            config.host,
        ]
    else:
        command = [
            "ping",
            "-c",
            "1",
            "-W",
            str(wait_seconds),
            config.host,
        ]

    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=max(1.0, timeout + 1.0),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return ProbeResult(
            config.name,
            config.probe_type,
            config.host,
            config.port,
            config.required,
            False,
            elapsed_ms(start),
            f"{type(error).__name__}: {error}",
        )

    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "ICMP failed").strip()
        return ProbeResult(
            config.name,
            config.probe_type,
            config.host,
            config.port,
            config.required,
            False,
            elapsed_ms(start),
            detail[:240],
        )

    actual_mac = resolve_neighbor_mac(config.host, timeout)
    expected_mac = normalize_mac(config.expected_mac)

    if expected_mac:
        if actual_mac is None:
            return ProbeResult(
                config.name,
                config.probe_type,
                config.host,
                config.port,
                config.required,
                False,
                elapsed_ms(start),
                "ICMP reachable; MAC identity not available",
            )

        if actual_mac != expected_mac:
            return ProbeResult(
                config.name,
                config.probe_type,
                config.host,
                config.port,
                config.required,
                False,
                elapsed_ms(start),
                (
                    "ICMP reachable; MAC identity mismatch "
                    f"(expected {expected_mac}, got {actual_mac})"
                ),
            )

        detail = f"ICMP reachable; MAC verified {actual_mac}"
    else:
        detail = (
            f"ICMP reachable; MAC {actual_mac}"
            if actual_mac
            else "ICMP reachable"
        )

    return ProbeResult(
        config.name,
        config.probe_type,
        config.host,
        config.port,
        config.required,
        True,
        elapsed_ms(start),
        detail,
    )


def probe_tcp(config: ProbeConfig, timeout: float) -> ProbeResult:
    start = time.perf_counter()
    try:
        with socket.create_connection((config.host, config.port), timeout=timeout):
            return ProbeResult(
                config.name,
                config.probe_type,
                config.host,
                config.port,
                config.required,
                True,
                elapsed_ms(start),
                "TCP connected",
            )
    except OSError as error:
        return ProbeResult(
            config.name,
            config.probe_type,
            config.host,
            config.port,
            config.required,
            False,
            elapsed_ms(start),
            f"{type(error).__name__}: {error}",
        )


def probe_http(config: ProbeConfig, timeout: float) -> ProbeResult:
    start = time.perf_counter()
    path = config.path if config.path.startswith("/") else f"/{config.path}"
    url = f"{config.probe_type}://{config.host}:{config.port}{path}"
    request = urllib.request.Request(
        url,
        method="HEAD",
        headers={"User-Agent": USER_AGENT},
    )
    context = (
        ssl._create_unverified_context()
        if config.probe_type == "https" and not config.verify_tls
        else None
    )
    try:
        with urllib.request.urlopen(
            request,
            timeout=timeout,
            context=context,
        ) as response:
            detail = f"HTTP {response.status}"
    except urllib.error.HTTPError as error:
        detail = f"HTTP {error.code}"
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return ProbeResult(
            config.name,
            config.probe_type,
            config.host,
            config.port,
            config.required,
            False,
            elapsed_ms(start),
            f"{type(error).__name__}: {error}",
        )
    return ProbeResult(
        config.name,
        config.probe_type,
        config.host,
        config.port,
        config.required,
        True,
        elapsed_ms(start),
        detail,
    )


def probe_rtsp(config: ProbeConfig, timeout: float) -> ProbeResult:
    start = time.perf_counter()
    path = config.path if config.path.startswith("/") else f"/{config.path}"
    request = (
        f"OPTIONS rtsp://{config.host}:{config.port}{path} RTSP/1.0\r\n"
        f"CSeq: 1\r\nUser-Agent: {USER_AGENT}\r\n\r\n"
    ).encode("ascii")
    try:
        with socket.create_connection((config.host, config.port), timeout=timeout) as connection:
            connection.settimeout(timeout)
            connection.sendall(request)
            try:
                response = connection.recv(512).decode("utf-8", errors="replace")
                detail = response.splitlines()[0] if response else "RTSP TCP connected"
            except socket.timeout:
                detail = "RTSP TCP connected"
            return ProbeResult(
                config.name,
                config.probe_type,
                config.host,
                config.port,
                config.required,
                True,
                elapsed_ms(start),
                detail,
            )
    except OSError as error:
        return ProbeResult(
            config.name,
            config.probe_type,
            config.host,
            config.port,
            config.required,
            False,
            elapsed_ms(start),
            f"{type(error).__name__}: {error}",
        )


def run_probe(config: ProbeConfig, timeout: float) -> ProbeResult:
    if config.probe_type == "icmp":
        return probe_icmp(config, timeout)
    if config.probe_type == "tcp":
        return probe_tcp(config, timeout)
    if config.probe_type in {"http", "https"}:
        return probe_http(config, timeout)
    return probe_rtsp(config, timeout)


def classify(results: list[ProbeResult]) -> str:
    if not results:
        return "OFFLINE"
    required = [item for item in results if item.required]
    considered = required or results
    successes = sum(1 for item in considered if item.success)
    if successes == len(considered):
        return "ONLINE"
    if successes:
        return "DEGRADED"
    return "OFFLINE"


class PendingStore:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS pending ("
                "device_id TEXT PRIMARY KEY, "
                "payload TEXT NOT NULL, "
                "updated_at TEXT NOT NULL)"
            )

    def save(self, device_id: str, payload: dict[str, Any]) -> None:
        with sqlite3.connect(self.path) as db:
            db.execute(
                "INSERT INTO pending(device_id,payload,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(device_id) DO UPDATE SET "
                "payload=excluded.payload, updated_at=excluded.updated_at",
                (device_id, json.dumps(payload), now_iso()),
            )

    def load(self, device_id: str) -> dict[str, Any] | None:
        with sqlite3.connect(self.path) as db:
            row = db.execute(
                "SELECT payload FROM pending WHERE device_id=?",
                (device_id,),
            ).fetchone()
        return json.loads(row[0]) if row else None

    def delete(self, device_id: str) -> None:
        with sqlite3.connect(self.path) as db:
            db.execute("DELETE FROM pending WHERE device_id=?", (device_id,))

    def count(self, device_id: str | None = None) -> int:
        with sqlite3.connect(self.path) as db:
            if device_id is None:
                row = db.execute("SELECT COUNT(*) FROM pending").fetchone()
            else:
                row = db.execute(
                    "SELECT COUNT(*) FROM pending WHERE device_id=?",
                    (device_id,),
                ).fetchone()
        return int(row[0]) if row else 0


class ApiClient:
    def __init__(self, api_url: str, device_id: str, device_key: str, timeout: float):
        self.api_url = api_url.rstrip("/")
        self.device_id = device_id
        self.device_key = device_key
        self.timeout = timeout

    def send(self, payload: dict[str, Any]) -> dict[str, Any]:
        request = urllib.request.Request(
            f"{self.api_url}/telemetry/ingest",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
                "x-device-id": self.device_id,
                "x-device-key": self.device_key,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"PSOP API returned HTTP {error.code}: {detail}"
            ) from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise RuntimeError(f"PSOP API unavailable: {error}") from error


class EdgeGateway:
    def __init__(self, config: GatewayConfig, api: ApiClient | None, store: PendingStore):
        self.config = config
        self.api = api
        self.store = store
        self.runtime_started_epoch = time.time()
        self.runtime_started_monotonic = time.monotonic()
        self.last_delivery_state: str | None = None
        self.last_successful_delivery_at: str | None = None
        self.last_delivery_error: str | None = None
        self.last_delivery_error_at: str | None = None

    def diagnose(self) -> tuple[str, list[ProbeResult]]:
        results = [
            run_probe(probe, self.config.timeout_seconds)
            for probe in self.config.probes
        ]
        return classify(results), results

    def runtime_metadata(
        self,
        pending_buffer_count: int | None = None,
    ) -> dict[str, Any]:
        metadata: dict[str, Any] = {
            "agentVersion": VERSION,
            "runtimeStartedAt": datetime.fromtimestamp(
                self.runtime_started_epoch,
                tz=timezone.utc,
            ).isoformat(),
            "runtimeUptimeSeconds": max(
                0,
                int(time.monotonic() - self.runtime_started_monotonic),
            ),
            "pendingBufferCount": (
                self.store.count(self.config.device_id)
                if pending_buffer_count is None
                else pending_buffer_count
            ),
        }
        if self.last_delivery_state:
            metadata["previousDeliveryState"] = self.last_delivery_state
        if self.last_successful_delivery_at:
            metadata["lastSuccessfulDeliveryAt"] = self.last_successful_delivery_at
        if self.last_delivery_error:
            metadata["lastDeliveryError"] = self.last_delivery_error
        if self.last_delivery_error_at:
            metadata["lastDeliveryErrorAt"] = self.last_delivery_error_at
        return metadata

    def build_payload(
        self,
        state: str,
        pending_buffer_count: int | None = None,
        results: list[ProbeResult] | None = None,
    ) -> dict[str, Any]:
        results = results or []

        failed_optional = [
            probe
            for probe in results
            if not probe.required and not probe.success
        ]
        failed_required = [
            probe
            for probe in results
            if probe.required and not probe.success
        ]

        # A degraded classification caused ONLY by optional probes failing is a
        # collection-quality gap, not a connectivity/health problem: report the
        # device as "online" and surface the gap via collectionState.
        if state == "DEGRADED" and not failed_required and failed_optional:
            status = "online"
        else:
            status = "online" if state == "ONLINE" else "warning"

        payload: dict[str, Any] = {
            "timestamp": int(time.time()),
            "status": status,
            **self.runtime_metadata(pending_buffer_count),
        }

        if results:
            payload["collectionState"] = (
                "PARTIAL" if failed_optional else "COMPLETE"
            )
            if failed_optional:
                payload["collectionIssues"] = [
                    {
                        "code": "OPTIONAL_ENRICHMENT_UNAVAILABLE",
                        "source": "GATEWAY",
                        "detail": f"{probe.name}: {probe.detail}"[:500],
                    }
                    for probe in failed_optional
                ]

        if self.config.model:
            payload["model"] = self.config.model
        if self.config.firmware:
            payload["firmware"] = self.config.firmware
        return payload

    def record_delivery_success(self) -> None:
        self.last_delivery_state = "DELIVERED"
        self.last_successful_delivery_at = now_iso()

    def record_delivery_failure(self, error: Exception | str, state: str = "BUFFERED") -> None:
        if state not in {"BUFFERED", "ERROR"}:
            state = "ERROR"
        self.last_delivery_state = state
        self.last_delivery_error = str(error)[:500]
        self.last_delivery_error_at = now_iso()

    def record_unexpected_error(self, error: Exception) -> None:
        self.record_delivery_failure(error, "ERROR")

    def finalize_cycle(self, cycle: dict[str, Any]) -> dict[str, Any]:
        runtime = self.runtime_metadata()
        cycle["runtime"] = {
            "agentVersion": VERSION,
            "uptimeSeconds": runtime["runtimeUptimeSeconds"],
            "pendingBufferCount": runtime["pendingBufferCount"],
            "lastDeliveryState": self.last_delivery_state,
            "lastSuccessfulDeliveryAt": self.last_successful_delivery_at,
            "lastDeliveryErrorAt": self.last_delivery_error_at,
        }
        return cycle

    def run_cycle(self) -> dict[str, Any]:
        state, results = self.diagnose()
        cycle = {
            "at": now_iso(),
            "deviceId": self.config.device_id,
            "externalId": self.config.external_id,
            "state": state,
            "delivery": "NOT_ATTEMPTED",
            "probes": [
                {
                    "name": r.name,
                    "type": r.probe_type,
                    "host": r.host,
                    "port": r.port,
                    "required": r.required,
                    "success": r.success,
                    "latencyMs": r.latency_ms,
                    "detail": r.detail,
                }
                for r in results
            ],
        }

        if state == "OFFLINE":
            self.store.delete(self.config.device_id)
            cycle["delivery"] = "WITHHELD_TARGET_OFFLINE"
            return self.finalize_cycle(cycle)

        if self.api is None:
            cycle["delivery"] = "DIAGNOSTIC_ONLY"
            return self.finalize_cycle(cycle)

        pending = self.store.load(self.config.device_id)
        if pending:
            try:
                self.api.send(pending)
                self.store.delete(self.config.device_id)
                cycle["pendingFlushed"] = True
            except RuntimeError as error:
                self.record_delivery_failure(error, "BUFFERED")
                self.store.save(
                    self.config.device_id,
                    self.build_payload(state, pending_buffer_count=1, results=results),
                )
                cycle["delivery"] = "BUFFERED"
                cycle["deliveryError"] = str(error)
                return self.finalize_cycle(cycle)

        payload = self.build_payload(state, results=results)
        try:
            response = self.api.send(payload)
            self.store.delete(self.config.device_id)
            self.record_delivery_success()
            cycle["delivery"] = "DELIVERED"
            cycle["psopState"] = response.get("connectivity", {}).get("state")
        except RuntimeError as error:
            self.record_delivery_failure(error, "BUFFERED")
            self.store.save(
                self.config.device_id,
                self.build_payload(state, pending_buffer_count=1, results=results),
            )
            cycle["delivery"] = "BUFFERED"
            cycle["deliveryError"] = str(error)

        return self.finalize_cycle(cycle)


def print_cycle(cycle: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(cycle, indent=2, sort_keys=True))
        return
    print(
        f"[{cycle['at']}] {cycle['externalId']} "
        f"state={cycle['state']} delivery={cycle['delivery']}"
    )
    for probe in cycle["probes"]:
        marker = "OK" if probe["success"] else "FAIL"
        req = "required" if probe["required"] else "optional"
        print(
            f"  [{marker}] {probe['name']} "
            f"{probe['type']}://{probe['host']}:{probe['port']} "
            f"{probe['latencyMs']}ms {req} — {probe['detail']}"
        )
    if cycle.get("psopState"):
        print(f"  PSOP connectivity state: {cycle['psopState']}")
    runtime = cycle.get("runtime") or {}
    print(
        f"  Agent {runtime.get('agentVersion', VERSION)} "
        f"runtime={runtime.get('uptimeSeconds', 0)}s "
        f"pending={runtime.get('pendingBufferCount', 0)}"
    )
    if cycle.get("deliveryError"):
        print(f"  Delivery error: {cycle['deliveryError']}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Monitor a camera/DVR/NVR and send heartbeats to PSOP"
    )
    parser.add_argument("--config", required=True)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--diagnose", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--interval", type=int)
    parser.add_argument("--version", action="version", version=VERSION)
    args = parser.parse_args()

    config = load_config(Path(args.config).expanduser().resolve())
    if args.interval:
        config = GatewayConfig(
            config.api_url,
            config.device_id,
            config.external_id,
            max(5, args.interval),
            config.timeout_seconds,
            config.model,
            config.firmware,
            config.spool_path,
            config.probes,
        )

    store = PendingStore(config.spool_path)
    api = None
    if not args.diagnose:
        key = os.getenv("PSOP_DEVICE_KEY", "")
        if not key:
            print(
                "PSOP_DEVICE_KEY is required unless --diagnose is used",
                file=sys.stderr,
            )
            return 2
        api = ApiClient(
            config.api_url,
            config.device_id,
            key,
            config.timeout_seconds,
        )

    gateway = EdgeGateway(config, api, store)
    stop = False

    def request_stop(signum, frame):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    while not stop:
        try:
            cycle = gateway.run_cycle()
            print_cycle(cycle, args.json)
        except Exception as error:
            gateway.record_unexpected_error(error)
            print(
                f"[{now_iso()}] Gateway cycle failed: "
                f"{type(error).__name__}: {error}",
                file=sys.stderr,
                flush=True,
            )
            if args.once or args.diagnose:
                return 4
            cycle = None

        if args.once or args.diagnose:
            if cycle is None:
                return 4
            return 0 if cycle["state"] != "OFFLINE" else 3

        deadline = time.monotonic() + config.interval_seconds
        while not stop and time.monotonic() < deadline:
            time.sleep(0.25)

    print("Gateway stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
