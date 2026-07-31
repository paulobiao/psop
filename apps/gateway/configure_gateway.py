#!/usr/bin/env python3
from __future__ import annotations

import getpass
import json
import os
import shlex
from pathlib import Path

DIR = Path(__file__).resolve().parent
CONFIG = DIR / "gateway.local.json"
ENV = DIR / ".env.local"


def ask(label: str, default: str) -> str:
    value = input(f"{label} [{default}]: ").strip()
    return value or default


def probe_type(port: int) -> str:
    if port == 80:
        return "http"
    if port == 443:
        return "https"
    if port == 554:
        return "rtsp"
    return "tcp"


def main() -> None:
    current = (
        json.loads(CONFIG.read_text())
        if CONFIG.exists()
        else {}
    )
    target = current.get("target") or {}

    api_url = ask(
        "PSOP API URL",
        current.get(
            "apiUrl",
            "http://127.0.0.1:3100/api/v1",
        ),
    )
    device_id = ask(
        "Camera device UUID",
        current.get(
            "deviceId",
            "00000000-0000-4000-8000-000000000000",
        ),
    )
    external_id = ask(
        "Camera external ID",
        current.get("externalId", "CAM-001"),
    )
    host = ask(
        "Camera/DVR/NVR local IP",
        target.get("host", "192.168.1.100"),
    )
    primary_port = int(
        ask("Primary required port", "80")
    )
    extras = ask(
        "Optional ports, comma separated",
        "443,554",
    )
    model = ask(
        "Model label",
        current.get(
            "model",
            "Lorex camera or recorder",
        ),
    )

    probes = [
        {
            "name": f"primary-{primary_port}",
            "type": probe_type(primary_port),
            "port": primary_port,
            "path": "/",
            "required": True,
            "verifyTls": False,
        }
    ]

    for raw in extras.split(","):
        raw = raw.strip()

        if not raw:
            continue

        port = int(raw)

        if port == primary_port:
            continue

        probes.append(
            {
                "name": f"optional-{port}",
                "type": probe_type(port),
                "port": port,
                "path": "/",
                "required": False,
                "verifyTls": False,
            }
        )

    payload = {
        "apiUrl": api_url,
        "deviceId": device_id,
        "externalId": external_id,
        "intervalSeconds": 30,
        "timeoutSeconds": 3,
        "model": model,
        "firmware": None,
        "spoolPath": (
            "apps/gateway/state/pending.db"
        ),
        "target": {
            "host": host,
        },
        "probes": probes,
    }

    CONFIG.write_text(
        json.dumps(
            payload,
            indent=2,
        )
        + "\n"
    )
    os.chmod(CONFIG, 0o600)

    existing_secret = ENV.exists()
    secret = getpass.getpass(
        "Device key"
        + (
            " (Enter keeps current)"
            if existing_secret
            else ""
        )
        + ": "
    )

    if secret:
        ENV.write_text(
            "export PSOP_DEVICE_KEY="
            + shlex.quote(secret)
            + "\n"
        )
        os.chmod(ENV, 0o600)
    elif not existing_secret:
        raise SystemExit(
            "A device key is required"
        )

    print(f"\nSaved config: {CONFIG}")
    print(
        f"Saved secret: {ENV} (mode 600)"
    )
    print(
        "\nDiagnose: "
        f"python3 {DIR / 'psop_gateway.py'} "
        f"--config {CONFIG} --diagnose"
    )
    print(
        "Run once: "
        f"bash {DIR / 'run_gateway.sh'} "
        f"--config {CONFIG} --once"
    )


if __name__ == "__main__":
    main()
