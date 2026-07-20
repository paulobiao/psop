"""
fleet.py
--------
Runs the whole simulated camera fleet at once.

Instead of launching simulator.py manually in many terminals, this script
starts one subprocess per camera, so the entire fleet publishes heartbeats
in parallel. Output from every camera is streamed to this single terminal.

Edit the FLEET list below to match the cameras you've provisioned.

Usage:
    python fleet.py
    python fleet.py --interval 5
"""

import argparse
import subprocess
import sys
import signal

# The fleet: each camera must already be provisioned (provision_camera.py).
# Format: (camera_id, site_id)
FLEET = [
    ("CAM-001", "boca-01"),
    ("CAM-002", "boca-01"),
    ("CAM-003", "boca-01"),
    ("CAM-004", "deerfield-02"),
    ("CAM-005", "deerfield-02"),
]


def main(interval: int):
    processes = []

    print(f"=== Starting fleet: {len(FLEET)} cameras ===\n")

    # Launch one simulator.py subprocess per camera.
    for camera_id, site_id in FLEET:
        proc = subprocess.Popen(
            [
                sys.executable, "simulator.py",
                "--camera-id", camera_id,
                "--site-id", site_id,
                "--interval", str(interval),
            ]
        )
        processes.append(proc)
        print(f"  started {camera_id} ({site_id})  [pid {proc.pid}]")

    print(f"\n=== Fleet running. Press Ctrl+C to stop all cameras. ===\n")

    # Wait until the user interrupts, then shut every camera down cleanly.
    try:
        for proc in processes:
            proc.wait()
    except KeyboardInterrupt:
        print("\n=== Stopping fleet... ===")
        for proc in processes:
            proc.send_signal(signal.SIGINT)  # tell each simulator to stop gracefully
        for proc in processes:
            proc.wait()
        print("=== All cameras stopped. ===")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run the full simulated camera fleet")
    parser.add_argument("--interval", type=int, default=10, help="Seconds between heartbeats (default 10)")
    args = parser.parse_args()

    main(args.interval)