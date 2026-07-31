#!/usr/bin/env python3
from __future__ import annotations

import os
import plistlib
import shlex
import subprocess
import sys
from pathlib import Path

LABEL = "com.psop.edge-gateway"
GATEWAY_DIR = Path(__file__).resolve().parent
ROOT = GATEWAY_DIR.parents[1]
CONFIG = GATEWAY_DIR / "gateway.local.json"
ENV_FILE = GATEWAY_DIR / ".env.local"
GATEWAY = GATEWAY_DIR / "psop_gateway.py"
STATE_DIR = GATEWAY_DIR / "state"
PLIST = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"


def domain() -> str:
    return f"gui/{os.getuid()}"


def target() -> str:
    return f"{domain()}/{LABEL}"


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(args),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def unload() -> None:
    run("launchctl", "bootout", target())
    run("launchctl", "bootout", domain(), str(PLIST))


def install() -> None:
    for path in (CONFIG, ENV_FILE, GATEWAY):
        if not path.exists():
            raise SystemExit(f"Missing required file: {path}")

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    PLIST.parent.mkdir(parents=True, exist_ok=True)

    python = Path(sys.executable).resolve()
    command = (
        "set -a; "
        f"source {shlex.quote(str(ENV_FILE))}; "
        "set +a; "
        f"exec {shlex.quote(str(python))} -u "
        f"{shlex.quote(str(GATEWAY))} "
        f"--config {shlex.quote(str(CONFIG))}"
    )

    payload = {
        "Label": LABEL,
        "ProgramArguments": ["/bin/bash", "-lc", command],
        "WorkingDirectory": str(ROOT),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ProcessType": "Background",
        "ThrottleInterval": 10,
        "StandardOutPath": str(STATE_DIR / "gateway.log"),
        "StandardErrorPath": str(STATE_DIR / "gateway-error.log"),
    }

    unload()
    PLIST.unlink(missing_ok=True)

    with PLIST.open("wb") as handle:
        plistlib.dump(payload, handle)

    os.chmod(PLIST, 0o600)

    result = run("launchctl", "bootstrap", domain(), str(PLIST))
    if result.returncode != 0:
        raise SystemExit(result.stdout.strip())

    run("launchctl", "kickstart", "-k", target())

    print(f"Installed and started: {LABEL}")
    print(f"Python: {python}")
    print(f"Logs: {STATE_DIR}")


def uninstall() -> None:
    unload()
    PLIST.unlink(missing_ok=True)
    print(f"Removed: {LABEL}")


def status() -> None:
    result = run("launchctl", "print", target())
    print(result.stdout.rstrip())
    raise SystemExit(result.returncode)


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in {
        "install",
        "uninstall",
        "status",
    }:
        raise SystemExit(
            "Usage: install_macos_service.py "
            "{install|uninstall|status}"
        )

    if sys.argv[1] == "install":
        install()
    elif sys.argv[1] == "uninstall":
        uninstall()
    else:
        status()


if __name__ == "__main__":
    main()
