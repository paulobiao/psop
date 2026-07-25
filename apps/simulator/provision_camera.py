"""
Provisions a PSOP database device in AWS IoT Core.

Usage:
    python provision_camera.py \
      --device-id 43c3f5c8-d702-4a20-90da-5e842d4e4e4f \
      --site-id 22222222-2222-4222-8222-222222222222 \
      --external-id CAM-001
"""

import argparse
import json
import os

import boto3

REGION = os.getenv("AWS_REGION", "us-east-1")
CERTS_DIR = "certs"


def provision(
    device_id: str,
    site_id: str,
    external_id: str,
):
    iot = boto3.client("iot", region_name=REGION)

    print(
        f"\n=== Provisioning {external_id} "
        f"({device_id}) ===\n"
    )

    thing_name = device_id

    try:
        iot.create_thing(
            thingName=thing_name,
            thingTypeName=(
                "camera-fleet-monitor-camera"
            ),
            attributePayload={
                "attributes": {
                    "site_id": site_id,
                    "external_id": external_id,
                }
            },
        )
        print(f"[1/4] Thing created: {thing_name}")
    except iot.exceptions.ResourceAlreadyExistsException:
        iot.update_thing(
            thingName=thing_name,
            attributePayload={
                "attributes": {
                    "site_id": site_id,
                    "external_id": external_id,
                },
                "merge": True,
            },
        )
        print(
            f"[1/4] Thing updated: {thing_name}"
        )

    cert_response = (
        iot.create_keys_and_certificate(
            setAsActive=True,
        )
    )

    cert_arn = cert_response["certificateArn"]
    cert_id = cert_response["certificateId"]

    os.makedirs(CERTS_DIR, exist_ok=True)

    cert_path = os.path.join(
        CERTS_DIR,
        f"{device_id}.cert.pem",
    )
    key_path = os.path.join(
        CERTS_DIR,
        f"{device_id}.private.key",
    )

    with open(cert_path, "w") as file:
        file.write(
            cert_response["certificatePem"]
        )

    with open(key_path, "w") as file:
        file.write(
            cert_response["keyPair"]["PrivateKey"]
        )

    print(f"[2/4] Certificate: {cert_path}")
    print(f"      Private key: {key_path}")

    account_id = (
        boto3.client("sts")
        .get_caller_identity()["Account"]
    )

    topic = (
        f"cameras/{site_id}/"
        f"{device_id}/heartbeat"
    )
    policy_name = f"camera-policy-{device_id}"

    policy_document = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": "iot:Connect",
                "Resource": (
                    f"arn:aws:iot:{REGION}:"
                    f"{account_id}:client/{device_id}"
                ),
            },
            {
                "Effect": "Allow",
                "Action": "iot:Publish",
                "Resource": (
                    f"arn:aws:iot:{REGION}:"
                    f"{account_id}:topic/{topic}"
                ),
            },
        ],
    }

    try:
        iot.create_policy(
            policyName=policy_name,
            policyDocument=json.dumps(
                policy_document,
            ),
        )
        print(
            f"[3/4] Policy created: "
            f"{policy_name}"
        )
    except iot.exceptions.ResourceAlreadyExistsException:
        print(
            f"[3/4] Policy already exists: "
            f"{policy_name}"
        )

    iot.attach_policy(
        policyName=policy_name,
        target=cert_arn,
    )
    iot.attach_thing_principal(
        thingName=thing_name,
        principal=cert_arn,
    )

    print("[4/4] Certificate and policy attached")
    print(f"Topic: {topic}")
    print(f"Certificate ID: {cert_id}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=(
            "Provision a PSOP database device "
            "in AWS IoT Core"
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
        help="Human-readable ID, e.g. CAM-001",
    )

    args = parser.parse_args()

    provision(
        args.device_id,
        args.site_id,
        args.external_id,
    )
