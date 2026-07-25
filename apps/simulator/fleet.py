"""
Runs the currently registered PSOP laboratory fleet.
"""

import argparse
import signal
import subprocess
import sys

FLEET = [
    (
        "43c3f5c8-d702-4a20-90da-5e842d4e4e4f",
        "22222222-2222-4222-8222-222222222222",
        "CAM-001",
    ),
]


def main(interval: int):
    processes = []

    print(
        f"=== Starting fleet: "
        f"{len(FLEET)} camera(s) ===\n"
    )

    for device_id, site_id, external_id in FLEET:
        process = subprocess.Popen(
            [
                sys.executable,
                "simulator.py",
                "--device-id",
                device_id,
                "--site-id",
                site_id,
                "--external-id",
                external_id,
                "--interval",
                str(interval),
            ]
        )

        processes.append(process)

        print(
            f"  started {external_id} "
            f"({device_id}) [pid {process.pid}]"
        )

    print(
        "\n=== Fleet running. "
        "Press Ctrl+C to stop. ===\n"
    )

    try:
        for process in processes:
            process.wait()
    except KeyboardInterrupt:
        print("\n=== Stopping fleet... ===")

        for process in processes:
            process.send_signal(signal.SIGINT)

        for process in processes:
            process.wait()

        print("=== All cameras stopped. ===")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Run the PSOP laboratory fleet",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=10,
        help="Seconds between heartbeats",
    )

    args = parser.parse_args()
    main(args.interval)
