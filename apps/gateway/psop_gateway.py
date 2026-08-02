#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import signal
import socket
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

VERSION = "1.1.0"
USER_AGENT = f"PSOP-Edge-Gateway/{VERSION}"

@dataclass(frozen=True)
class ProbeConfig:
    name: str
    probe_type: str
    host: str
    port: int
    path: str = "/"
    required: bool = True
    verify_tls: bool = False

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
        if probe_type not in {"tcp", "http", "https", "rtsp"}:
            raise ValueError(f"Unsupported probe type: {probe_type}")
        port = int(item.get("port") or 0)
        if not 1 <= port <= 65535:
            raise ValueError(f"Invalid probe port at index {index}")
        probes.append(ProbeConfig(
            name=str(item.get("name") or f"probe-{index}"),
            probe_type=probe_type,
            host=str(item.get("host") or host),
            port=port,
            path=str(item.get("path") or "/"),
            required=bool(item.get("required", True)),
            verify_tls=bool(item.get("verifyTls", False)),
        ))
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

def probe_tcp(config: ProbeConfig, timeout: float) -> ProbeResult:
    start = time.perf_counter()
    try:
        with socket.create_connection((config.host, config.port), timeout=timeout):
            return ProbeResult(config.name, config.probe_type, config.host, config.port, config.required, True, elapsed_ms(start), "TCP connected")
    except OSError as error:
        return ProbeResult(config.name, config.probe_type, config.host, config.port, config.required, False, elapsed_ms(start), f"{type(error).__name__}: {error}")

def probe_http(config: ProbeConfig, timeout: float) -> ProbeResult:
    start = time.perf_counter()
    path = config.path if config.path.startswith("/") else f"/{config.path}"
    url = f"{config.probe_type}://{config.host}:{config.port}{path}"
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    context = ssl._create_unverified_context() if config.probe_type == "https" and not config.verify_tls else None
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            detail = f"HTTP {response.status}"
    except urllib.error.HTTPError as error:
        detail = f"HTTP {error.code}"
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return ProbeResult(config.name, config.probe_type, config.host, config.port, config.required, False, elapsed_ms(start), f"{type(error).__name__}: {error}")
    return ProbeResult(config.name, config.probe_type, config.host, config.port, config.required, True, elapsed_ms(start), detail)

def probe_rtsp(config: ProbeConfig, timeout: float) -> ProbeResult:
    start = time.perf_counter()
    path = config.path if config.path.startswith("/") else f"/{config.path}"
    request = (f"OPTIONS rtsp://{config.host}:{config.port}{path} RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: {USER_AGENT}\r\n\r\n").encode("ascii")
    try:
        with socket.create_connection((config.host, config.port), timeout=timeout) as connection:
            connection.settimeout(timeout)
            connection.sendall(request)
            try:
                response = connection.recv(512).decode("utf-8", errors="replace")
                detail = response.splitlines()[0] if response else "RTSP TCP connected"
            except socket.timeout:
                detail = "RTSP TCP connected"
            return ProbeResult(config.name, config.probe_type, config.host, config.port, config.required, True, elapsed_ms(start), detail)
    except OSError as error:
        return ProbeResult(config.name, config.probe_type, config.host, config.port, config.required, False, elapsed_ms(start), f"{type(error).__name__}: {error}")

def run_probe(config: ProbeConfig, timeout: float) -> ProbeResult:
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
            db.execute("CREATE TABLE IF NOT EXISTS pending (device_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)")
    def save(self, device_id: str, payload: dict[str, Any]) -> None:
        with sqlite3.connect(self.path) as db:
            db.execute("INSERT INTO pending(device_id,payload,updated_at) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at", (device_id, json.dumps(payload), now_iso()))
    def load(self, device_id: str) -> dict[str, Any] | None:
        with sqlite3.connect(self.path) as db:
            row = db.execute("SELECT payload FROM pending WHERE device_id=?", (device_id,)).fetchone()
        return json.loads(row[0]) if row else None
    def delete(self, device_id: str) -> None:
        with sqlite3.connect(self.path) as db:
            db.execute("DELETE FROM pending WHERE device_id=?", (device_id,))

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
            headers={"Accept":"application/json","Content-Type":"application/json","User-Agent":USER_AGENT,"x-device-id":self.device_id,"x-device-key":self.device_key},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"PSOP API returned HTTP {error.code}: {detail}") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise RuntimeError(f"PSOP API unavailable: {error}") from error

class EdgeGateway:
    def __init__(self, config: GatewayConfig, api: ApiClient | None, store: PendingStore):
        self.config = config
        self.api = api
        self.store = store
    def diagnose(self) -> tuple[str, list[ProbeResult]]:
        results = [run_probe(probe, self.config.timeout_seconds) for probe in self.config.probes]
        return classify(results), results
    def build_payload(self, state: str) -> dict[str, Any]:
        payload: dict[str, Any] = {"timestamp": int(time.time()), "status": "online" if state == "ONLINE" else "warning"}
        if self.config.model:
            payload["model"] = self.config.model
        if self.config.firmware:
            payload["firmware"] = self.config.firmware
        return payload
    def run_cycle(self) -> dict[str, Any]:
        state, results = self.diagnose()
        cycle = {"at":now_iso(),"deviceId":self.config.device_id,"externalId":self.config.external_id,"state":state,"delivery":"NOT_ATTEMPTED","probes":[{"name":r.name,"type":r.probe_type,"host":r.host,"port":r.port,"required":r.required,"success":r.success,"latencyMs":r.latency_ms,"detail":r.detail} for r in results]}
        if state == "OFFLINE":
            self.store.delete(self.config.device_id)
            cycle["delivery"] = "WITHHELD_TARGET_OFFLINE"
            return cycle
        if self.api is None:
            cycle["delivery"] = "DIAGNOSTIC_ONLY"
            return cycle
        pending = self.store.load(self.config.device_id)
        if pending:
            try:
                self.api.send(pending)
                self.store.delete(self.config.device_id)
                cycle["pendingFlushed"] = True
            except RuntimeError as error:
                self.store.save(self.config.device_id, self.build_payload(state))
                cycle["delivery"] = "BUFFERED"
                cycle["deliveryError"] = str(error)
                return cycle
        payload = self.build_payload(state)
        try:
            response = self.api.send(payload)
            self.store.delete(self.config.device_id)
            cycle["delivery"] = "DELIVERED"
            cycle["psopState"] = response.get("connectivity", {}).get("state")
        except RuntimeError as error:
            self.store.save(self.config.device_id, payload)
            cycle["delivery"] = "BUFFERED"
            cycle["deliveryError"] = str(error)
        return cycle

def print_cycle(cycle: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(cycle, indent=2, sort_keys=True))
        return
    print(f"[{cycle['at']}] {cycle['externalId']} state={cycle['state']} delivery={cycle['delivery']}")
    for probe in cycle["probes"]:
        marker = "OK" if probe["success"] else "FAIL"
        req = "required" if probe["required"] else "optional"
        print(f"  [{marker}] {probe['name']} {probe['type']}://{probe['host']}:{probe['port']} {probe['latencyMs']}ms {req} — {probe['detail']}")
    if cycle.get("psopState"):
        print(f"  PSOP connectivity state: {cycle['psopState']}")
    if cycle.get("deliveryError"):
        print(f"  Delivery error: {cycle['deliveryError']}")

def main() -> int:
    parser = argparse.ArgumentParser(description="Monitor a camera/DVR/NVR and send heartbeats to PSOP")
    parser.add_argument("--config", required=True)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--diagnose", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--interval", type=int)
    parser.add_argument("--version", action="version", version=VERSION)
    args = parser.parse_args()
    config = load_config(Path(args.config).expanduser().resolve())
    if args.interval:
        config = GatewayConfig(config.api_url, config.device_id, config.external_id, max(5,args.interval), config.timeout_seconds, config.model, config.firmware, config.spool_path, config.probes)
    store = PendingStore(config.spool_path)
    api = None
    if not args.diagnose:
        key = os.getenv("PSOP_DEVICE_KEY", "")
        if not key:
            print("PSOP_DEVICE_KEY is required unless --diagnose is used", file=sys.stderr)
            return 2
        api = ApiClient(config.api_url, config.device_id, key, config.timeout_seconds)
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

            return (
                0
                if cycle["state"] != "OFFLINE"
                else 3
            )

        deadline = (
            time.monotonic()
            + config.interval_seconds
        )

        while (
            not stop
            and time.monotonic() < deadline
        ):
            time.sleep(0.25)
    print("Gateway stopped")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
