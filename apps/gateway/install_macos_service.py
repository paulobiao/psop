#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import plistlib
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

LABEL = "dev.biaotech.psop.edge-gateway"
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
RUNNER = HERE / "run_gateway.sh"
GATEWAY = HERE / "psop_gateway.py"
DEFAULT_CONFIG = HERE / "gateway.local.json"
ENV_FILE = HERE / ".env.local"
STATE_DIR = HERE / "state"
STDOUT_LOG = STATE_DIR / "gateway.stdout.log"
STDERR_LOG = STATE_DIR / "gateway.stderr.log"
PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"

DEVICE_KEY_PATTERN = re.compile(
    r"(?m)^\s*(?:export\s+)?PSOP_DEVICE_KEY\s*=\s*(.+?)\s*$"
)


def domain() -> str:
    return f"gui/{os.getuid()}"


def service_target() -> str:
    return f"{domain()}/{LABEL}"


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(args),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def resolve_config(value: str | Path) -> Path:
    path = Path(value).expanduser()

    if not path.is_absolute():
        path = (ROOT / path).resolve()

    return path


def has_device_key(path: Path = ENV_FILE) -> bool:
    if not path.is_file():
        return False

    match = DEVICE_KEY_PATTERN.search(
        path.read_text(errors="replace")
    )

    if not match:
        return False

    value = match.group(1).strip()

    return bool(value and value not in {"''", '""'})


def ensure_local_runtime(config_path: Path) -> None:
    if sys.platform != "darwin":
        raise RuntimeError(
            "The persistent service installer is available only on macOS"
        )

    required = [
        (RUNNER, "gateway runner"),
        (GATEWAY, "gateway application"),
        (config_path, "local gateway configuration"),
        (ENV_FILE, "local gateway secret file"),
    ]

    for path, label in required:
        if not path.is_file():
            raise RuntimeError(f"Missing {label}: {path}")

    try:
        raw = json.loads(config_path.read_text())
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Invalid gateway JSON: {error}") from error

    for field in ("apiUrl", "deviceId", "externalId", "target", "probes"):
        if not raw.get(field):
            raise RuntimeError(
                f"Gateway configuration is missing {field}"
            )

    if not has_device_key():
        raise RuntimeError(
            f"PSOP_DEVICE_KEY is missing from {ENV_FILE}"
        )

    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    STATE_DIR.chmod(0o700)

    for path in (config_path, ENV_FILE):
        path.chmod(0o600)

    for path in (STDOUT_LOG, STDERR_LOG):
        path.touch(exist_ok=True)
        path.chmod(0o600)


def build_plist(
    config_path: Path,
    *,
    python_path: Path | None = None,
    root: Path = ROOT,
    runner: Path = RUNNER,
    stdout_path: Path = STDOUT_LOG,
    stderr_path: Path = STDERR_LOG,
) -> dict[str, Any]:
    resolved_python = (python_path or Path(sys.executable)).resolve()

    return {
        "Label": LABEL,
        "ProgramArguments": [
            "/bin/bash",
            str(runner.resolve()),
            "--config",
            str(config_path.resolve()),
        ],
        "WorkingDirectory": str(root.resolve()),
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 10,
        "ProcessType": "Background",
        "EnvironmentVariables": {
            "PSOP_PYTHON": str(resolved_python),
            "PYTHONUNBUFFERED": "1",
        },
        "StandardOutPath": str(stdout_path.resolve()),
        "StandardErrorPath": str(stderr_path.resolve()),
    }


def loaded() -> bool:
    return run("launchctl", "print", service_target()).returncode == 0


def bootout() -> None:
    if not loaded():
        return

    result = run("launchctl", "bootout", service_target())

    if result.returncode != 0:
        raise RuntimeError(
            "Unable to stop gateway service:\n" + result.stdout
        )


def bootstrap() -> None:
    result = run("launchctl", "bootstrap", domain(), str(PLIST))

    if result.returncode != 0:
        raise RuntimeError(
            "Unable to load gateway service:\n" + result.stdout
        )

    run("launchctl", "enable", service_target())

    kick = run("launchctl", "kickstart", "-k", service_target())

    if kick.returncode != 0:
        raise RuntimeError(
            "Service loaded but could not start:\n" + kick.stdout
        )


def write_plist(config_path: Path) -> None:
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    temporary = PLIST.with_suffix(".plist.tmp")

    with temporary.open("wb") as handle:
        plistlib.dump(
            build_plist(config_path),
            handle,
            sort_keys=True,
        )

    temporary.chmod(0o644)
    temporary.replace(PLIST)
    PLIST.chmod(0o644)


def rotate_log(
    path: Path,
    *,
    maximum_bytes: int = 5 * 1024 * 1024,
    backups: int = 3,
) -> None:
    if not path.exists() or path.stat().st_size < maximum_bytes:
        return

    path.with_name(f"{path.name}.{backups}").unlink(missing_ok=True)

    for index in range(backups - 1, 0, -1):
        current = path.with_name(f"{path.name}.{index}")
        following = path.with_name(f"{path.name}.{index + 1}")

        if current.exists():
            current.replace(following)

    path.replace(path.with_name(f"{path.name}.1"))
    path.touch()
    path.chmod(0o600)


def install(config_path: Path) -> None:
    ensure_local_runtime(config_path)
    bootout()
    rotate_log(STDOUT_LOG)
    rotate_log(STDERR_LOG)
    write_plist(config_path)
    bootstrap()

    print("Gateway service installed and started.")
    print(f"Label: {LABEL}")
    print(f"Plist: {PLIST}")
    print(f"Logs: {STDOUT_LOG}")


def start() -> None:
    if loaded():
        result = run(
            "launchctl",
            "kickstart",
            "-k",
            service_target(),
        )

        if result.returncode != 0:
            raise RuntimeError(
                "Unable to restart loaded service:\n" + result.stdout
            )

        print("Gateway service started.")
        return

    if not PLIST.is_file():
        raise RuntimeError(
            "Gateway service is not installed. Run install first."
        )

    bootstrap()
    print("Gateway service started.")


def stop() -> None:
    if not loaded():
        print("Gateway service is already stopped.")
        return

    bootout()
    print("Gateway service stopped. The plist remains installed.")


def restart() -> None:
    if not PLIST.is_file():
        raise RuntimeError("Gateway service is not installed.")

    bootout()
    rotate_log(STDOUT_LOG)
    rotate_log(STDERR_LOG)
    bootstrap()
    print("Gateway service restarted.")


def uninstall() -> None:
    bootout()
    PLIST.unlink(missing_ok=True)
    print("Gateway service uninstalled.")
    print(
        "Local configuration, secret, buffer and logs were preserved."
    )


def parse_service_details(output: str) -> dict[str, str | None]:
    def value(pattern: str) -> str | None:
        match = re.search(pattern, output, re.MULTILINE)
        return match.group(1).strip() if match else None

    return {
        "state": value(r"^\s*state\s*=\s*(.+)$"),
        "pid": value(r"^\s*pid\s*=\s*(\d+)$"),
        "lastExitStatus": value(
            r"^\s*last exit code\s*=\s*(.+)$"
        ),
    }


def last_nonempty_line(path: Path) -> str | None:
    if not path.is_file():
        return None

    lines = [
        line.strip()
        for line in path.read_text(errors="replace").splitlines()
        if line.strip()
    ]

    return lines[-1] if lines else None


def status() -> None:
    result = run("launchctl", "print", service_target())

    if result.returncode == 0:
        details = parse_service_details(result.stdout)
        print("Gateway service: RUNNING")
        print(f"State: {details['state'] or 'loaded'}")
        print(f"PID: {details['pid'] or 'not reported'}")

        if details["lastExitStatus"]:
            print(
                f"Last exit status: {details['lastExitStatus']}"
            )
    elif PLIST.is_file():
        print("Gateway service: INSTALLED BUT STOPPED")
    else:
        print("Gateway service: NOT INSTALLED")

    print(f"Plist: {PLIST}")
    print(f"Standard log: {STDOUT_LOG}")
    print(f"Error log: {STDERR_LOG}")

    latest = last_nonempty_line(STDOUT_LOG)

    if latest:
        print(f"Latest output: {latest}")

    latest_error = last_nonempty_line(STDERR_LOG)

    if latest_error:
        print(f"Latest error: {latest_error}")


def show_logs(lines: int, follow: bool) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)

    for path in (STDOUT_LOG, STDERR_LOG):
        path.touch(exist_ok=True)
        path.chmod(0o600)

    command = ["/usr/bin/tail", "-n", str(max(1, lines))]

    if follow:
        command.append("-f")

    command.extend([str(STDOUT_LOG), str(STDERR_LOG)])

    raise SystemExit(subprocess.call(command))


def doctor(config_path: Path) -> None:
    ensure_local_runtime(config_path)

    serialized = plistlib.dumps(
        build_plist(config_path)
    ).decode("utf-8")

    if "PSOP_DEVICE_KEY" in serialized:
        raise RuntimeError("Secret field leaked into plist")

    print("Gateway runtime doctor: APPROVED")
    print(
        "Local config and secret exist with restricted permissions."
    )
    print("The launchd plist contains no device secret.")
    print(f"Python runtime: {Path(sys.executable).resolve()}")


def build_parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description=(
            "Install and control the PSOP Edge Gateway "
            "macOS LaunchAgent"
        )
    )

    result.add_argument(
        "--config",
        default=str(DEFAULT_CONFIG),
        help=(
            "Gateway JSON configuration path "
            "(default: apps/gateway/gateway.local.json)"
        ),
    )

    subcommands = result.add_subparsers(
        dest="command",
        required=True,
    )

    for name in (
        "install",
        "start",
        "stop",
        "restart",
        "status",
        "uninstall",
        "doctor",
    ):
        subcommands.add_parser(name)

    logs = subcommands.add_parser("logs")
    logs.add_argument("--lines", type=int, default=80)
    logs.add_argument("--follow", action="store_true")

    return result


def main() -> int:
    args = build_parser().parse_args()
    config_path = resolve_config(args.config)

    try:
        if args.command == "install":
            install(config_path)
        elif args.command == "start":
            start()
        elif args.command == "stop":
            stop()
        elif args.command == "restart":
            restart()
        elif args.command == "status":
            status()
        elif args.command == "uninstall":
            uninstall()
        elif args.command == "doctor":
            doctor(config_path)
        elif args.command == "logs":
            show_logs(args.lines, args.follow)
    except RuntimeError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
