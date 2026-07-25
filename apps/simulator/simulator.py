"""
Simulates an IP security camera publishing heartbeats to AWS IoT Core.

Usage:
    python simulator.py \
      --device-id 43c3f5c8-d702-4a20-90da-5e842d4e4e4f \
      --site-id 22222222-2222-4222-8222-222222222222 \
      --external-id CAM-001
"""

import argparse
import json
import os
import random
import ssl
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt

IOT_ENDPOINT = os.getenv("AWS_IOT_ENDPOINT", "")
IOT_PORT = 8883
CERTS_DIR = "certs"

CAMERA_MODEL = "BiaoCam-IP-4K"
FIRMWARE_VERSION = "2.4.1"


def build_heartbeat(
    device_id: str,
    site_id: str,
    external_id: str,
) -> dict:
    return {
        "camera_id": device_id,
        "site_id": site_id,
        "external_id": external_id,
        "model": CAMERA_MODEL,
        "firmware": FIRMWARE_VERSION,
        "status": "online",
        "timestamp": int(time.time()),
        "iso_time": datetime.now(timezone.utc).isoformat(),
        "temperature_c": round(random.uniform(35.0, 55.0), 1),
        "bitrate_kbps": random.randint(2000, 6000),
        "storage_used_pct": round(
            random.uniform(40.0, 85.0),
            1,
        ),
        "uptime_seconds": random.randint(
            3600,
            2592000,
        ),
    }


def on_connect(
    client,
    userdata,
    flags,
    reason_code,
    properties=None,
):
    if reason_code == 0:
        print(
            f"[MQTT] Connected to AWS IoT Core "
            f"({IOT_ENDPOINT})"
        )
    else:
        print(
            f"[MQTT] Connection failed, "
            f"reason code: {reason_code}"
        )


def on_publish(
    client,
    userdata,
    mid,
    reason_code=None,
    properties=None,
):
    print(
        f"[MQTT] -> heartbeat published "
        f"(message id {mid})"
    )


def run(
    device_id: str,
    site_id: str,
    external_id: str,
    interval: int,
):
    if not IOT_ENDPOINT:
        raise RuntimeError(
            "AWS_IOT_ENDPOINT is not configured."
        )

    ca_path = os.path.join(
        CERTS_DIR,
        "AmazonRootCA1.pem",
    )
    cert_path = os.path.join(
        CERTS_DIR,
        f"{device_id}.cert.pem",
    )
    key_path = os.path.join(
        CERTS_DIR,
        f"{device_id}.private.key",
    )

    for path in (ca_path, cert_path, key_path):
        if not os.path.exists(path):
            raise FileNotFoundError(
                f"Missing certificate file: {path}\n"
                "Provision this database device UUID first."
            )

    topic = (
        f"cameras/{site_id}/"
        f"{device_id}/heartbeat"
    )

    client = mqtt.Client(
        client_id=device_id,
        protocol=mqtt.MQTTv311,
    )
    client.on_connect = on_connect
    client.on_publish = on_publish

    client.tls_set(
        ca_certs=ca_path,
        certfile=cert_path,
        keyfile=key_path,
        tls_version=ssl.PROTOCOL_TLSv1_2,
    )

    print(
        f"Connecting {external_id} "
        f"(device {device_id}, site {site_id})..."
    )

    client.connect(
        IOT_ENDPOINT,
        IOT_PORT,
        keepalive=60,
    )
    client.loop_start()

    print(
        f"Publishing heartbeats to '{topic}' "
        f"every {interval}s. Press Ctrl+C to stop.\n"
    )

    try:
        while True:
            payload = build_heartbeat(
                device_id,
                site_id,
                external_id,
            )

            client.publish(
                topic,
                json.dumps(payload),
                qos=1,
            )

            print(
                f"[{payload['iso_time']}] "
                f"{external_id}: "
                f"{payload['temperature_c']}°C, "
                f"{payload['bitrate_kbps']} kbps, "
                f"disk {payload['storage_used_pct']}%"
            )

            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nStopping simulator...")
    finally:
        client.loop_stop()
        client.disconnect()
        print("Disconnected.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=(
            "Simulate a PSOP camera sending "
            "heartbeats to AWS IoT Core"
        )
    )
    parser.add_argument(
        "--device-id",
        required=True,
        help="Device UUID stored in PostgreSQL",
    )
    parser.add_argument(
        "--site-id",
        required=True,
        help="Site UUID stored in PostgreSQL",
    )
    parser.add_argument(
        "--external-id",
        required=True,
        help="Human-readable camera ID, e.g. CAM-001",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=10,
        help="Seconds between heartbeats",
    )

    args = parser.parse_args()

    run(
        args.device_id,
        args.site_id,
        args.external_id,
        args.interval,
    )
