# Authenticated local PSOP camera simulator.

import argparse
import json
import os
import random
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

DEFAULT_API_URL = "http://127.0.0.1:3100/api/v1"


def build_payload(state: str) -> dict:
    now = int(time.time())
    payload = {
        "timestamp": now,
        "status": "online",
        "temperatureC": round(random.uniform(40, 48), 1),
        "bitrateKbps": random.randint(2500, 5500),
        "storageUsedPct": round(random.uniform(45, 65), 1),
        "uptimeSeconds": random.randint(3600, 2592000),
        "model": "PSOP Local Camera",
        "firmware": "local-1.0.0",
    }

    if state == "degraded":
        payload.update(
            status="warning",
            temperatureC=82.0,
            storageUsedPct=96.0,
        )
    elif state == "unknown":
        payload.update(
            status="unexpected-vendor-state",
            temperatureC=45.0,
            storageUsedPct=50.0,
        )
    elif state == "offline":
        payload.update(
            status="offline",
            timestamp=now - 3600,
            temperatureC=44.0,
            storageUsedPct=55.0,
        )

    return payload


def send(api_url, device_id, device_key, state):
    request = urllib.request.Request(
        f"{api_url.rstrip('/')}/telemetry/ingest",
        data=json.dumps(build_payload(state)).encode("utf-8"),
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "x-device-id": device_id,
            "x-device-key": device_key,
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"PSOP API returned HTTP {error.code}: {detail}"
        ) from error

    connectivity = body.get("connectivity", {})
    telemetry = body.get("telemetry") or {}

    print(
        f"[{datetime.now(timezone.utc).isoformat()}] "
        f"state={connectivity.get('state')} "
        f"temperature={telemetry.get('temperatureC')} "
        f"storage={telemetry.get('storageUsedPct')}"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-url", default=DEFAULT_API_URL)
    parser.add_argument("--device-id", required=True)
    parser.add_argument(
        "--device-key",
        default=os.getenv("PSOP_DEVICE_KEY", ""),
    )
    parser.add_argument(
        "--state",
        choices=["online", "degraded", "offline", "unknown"],
        default="online",
    )
    parser.add_argument("--interval", type=int, default=10)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()

    if not args.device_key:
        raise SystemExit(
            "PSOP_DEVICE_KEY or --device-key is required."
        )

    print("=== PSOP Local HTTP Simulator ===")
    print(f"Device: {args.device_id}")
    print(f"State: {args.state}")

    try:
        while True:
            send(
                args.api_url,
                args.device_id,
                args.device_key,
                args.state,
            )
            if args.once:
                return
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nSimulator stopped.")


if __name__ == "__main__":
    main()
