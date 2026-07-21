"""
simulator.py
------------
Simulates an IP security camera publishing heartbeats to AWS IoT Core
over MQTT/TLS, using the X.509 certificate created by provision_camera.py.

Each heartbeat reports the camera's health: status, temperature, bitrate,
storage usage, firmware. This is the kind of telemetry a real camera fleet emits.

Usage:
    python simulator.py --camera-id CAM-001 --site-id boca-01
    python simulator.py --camera-id CAM-001 --site-id boca-01 --interval 5
"""

import argparse
import json
import os
import ssl
import time
import random
from datetime import datetime, timezone

import paho.mqtt.client as mqtt

# Must match the Terraform infra and the provisioning script.
IOT_ENDPOINT = os.getenv("AWS_IOT_ENDPOINT", "")
IOT_PORT = 8883  # standard port for MQTT over TLS
CERTS_DIR = "certs"

# A little static metadata to make each camera feel real.
CAMERA_MODEL = "BiaoCam-IP-4K"
FIRMWARE_VERSION = "2.4.1"


def build_heartbeat(camera_id: str, site_id: str) -> dict:
    """Create one heartbeat payload with simulated health metrics."""
    return {
        "camera_id": camera_id,
        "site_id": site_id,
        "model": CAMERA_MODEL,
        "firmware": FIRMWARE_VERSION,
        "status": "online",
        "timestamp": int(time.time()),                 # epoch seconds
        "iso_time": datetime.now(timezone.utc).isoformat(),
        "temperature_c": round(random.uniform(35.0, 55.0), 1),
        "bitrate_kbps": random.randint(2000, 6000),
        "storage_used_pct": round(random.uniform(40.0, 85.0), 1),
        "uptime_seconds": random.randint(3600, 2592000),
    }


# ---- MQTT connection callbacks (paho calls these on events) ----

def on_connect(client, userdata, flags, reason_code, properties=None):
    if reason_code == 0:
        print(f"[MQTT] Connected to AWS IoT Core ({IOT_ENDPOINT})")
    else:
        print(f"[MQTT] Connection failed, reason code: {reason_code}")


def on_publish(client, userdata, mid, reason_code=None, properties=None):
    print(f"[MQTT]   -> heartbeat published (message id {mid})")


def run(camera_id: str, site_id: str, interval: int):
    if not IOT_ENDPOINT:
        raise RuntimeError(
            "AWS_IOT_ENDPOINT is not configured. "
            "Set it before starting the simulator."
        )

    # The three files that make mutual TLS work:
    ca_path = os.path.join(CERTS_DIR, "AmazonRootCA1.pem")     # trust AWS
    cert_path = os.path.join(CERTS_DIR, f"{camera_id}.cert.pem")   # camera identity
    key_path = os.path.join(CERTS_DIR, f"{camera_id}.private.key") # camera secret

    # Fail early with a clear message if a certificate is missing.
    for path in (ca_path, cert_path, key_path):
        if not os.path.exists(path):
            raise FileNotFoundError(
                f"Missing certificate file: {path}\n"
                f"Run: python provision_camera.py --camera-id {camera_id} --site-id {site_id}"
            )

    topic = f"cameras/{site_id}/{camera_id}/heartbeat"

    # MQTT client id MUST equal the camera_id — our IoT policy only allows
    # connecting with client id == camera_id (least privilege in action).
    client = mqtt.Client(client_id=camera_id, protocol=mqtt.MQTTv311)
    client.on_connect = on_connect
    client.on_publish = on_publish

    # Configure mutual TLS with our certificates.
    client.tls_set(
        ca_certs=ca_path,
        certfile=cert_path,
        keyfile=key_path,
        tls_version=ssl.PROTOCOL_TLSv1_2,
    )

    print(f"Connecting camera '{camera_id}' (site '{site_id}')...")
    client.connect(IOT_ENDPOINT, IOT_PORT, keepalive=60)
    client.loop_start()

    print(f"Publishing heartbeats to '{topic}' every {interval}s. Press Ctrl+C to stop.\n")
    try:
        while True:
            payload = build_heartbeat(camera_id, site_id)
            client.publish(topic, json.dumps(payload), qos=1)
            print(f"[{payload['iso_time']}] {camera_id}: "
                  f"{payload['temperature_c']}°C, "
                  f"{payload['bitrate_kbps']} kbps, "
                  f"disk {payload['storage_used_pct']}%")
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nStopping simulator...")
    finally:
        try:
            client.loop_stop()
            client.disconnect()
            print("Disconnected.")
        except KeyboardInterrupt:
            pass  # ignore a second Ctrl+C arriving mid-shutdown


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Simulate an IP camera sending heartbeats to AWS IoT Core")
    parser.add_argument("--camera-id", required=True, help="Camera ID, e.g. CAM-001")
    parser.add_argument("--site-id", required=True, help="Site ID, e.g. boca-01")
    parser.add_argument("--interval", type=int, default=10, help="Seconds between heartbeats (default 10)")
    args = parser.parse_args()

    run(args.camera_id, args.site_id, args.interval)