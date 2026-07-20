"""
provision_camera.py
--------------------
Provisions a single simulated camera in AWS IoT Core:
  1. Creates an IoT "Thing" (the device's registered identity)
  2. Creates an X.509 certificate + private key (the device's credentials)
  3. Creates an IoT policy scoped to ONLY this camera's topic (least privilege)
  4. Attaches the policy to the certificate, and the certificate to the Thing

This mirrors how a real device provisioning service onboards a new camera.
Certificates are saved locally under ./certs/ (which is .gitignored).

Usage:
    python provision_camera.py --camera-id CAM-001 --site-id boca-01
"""

import argparse
import json
import os
import boto3

# The AWS region must match where the Terraform infra was created.
REGION = "us-east-1"

# Folder where this camera's certificate files will be saved locally.
CERTS_DIR = "certs"


def provision(camera_id: str, site_id: str):
    iot = boto3.client("iot", region_name=REGION)

    print(f"\n=== Provisioning camera '{camera_id}' at site '{site_id}' ===\n")

    # ------------------------------------------------------------------
    # Step 1: Create the "Thing" — the device's identity in the registry.
    # ------------------------------------------------------------------
    thing_name = camera_id
    try:
        iot.create_thing(
            thingName=thing_name,
            thingTypeName="camera-fleet-monitor-camera",
            attributePayload={"attributes": {"site_id": site_id}},
        )
        print(f"[1/4] Thing created: {thing_name}")
    except iot.exceptions.ResourceAlreadyExistsException:
        print(f"[1/4] Thing already exists: {thing_name} (skipping)")

    # ------------------------------------------------------------------
    # Step 2: Create the certificate + key pair (the device credentials).
    # AWS generates and returns them; the private key is shown ONLY once.
    # ------------------------------------------------------------------
    cert_response = iot.create_keys_and_certificate(setAsActive=True)
    cert_arn = cert_response["certificateArn"]
    cert_id = cert_response["certificateId"]

    os.makedirs(CERTS_DIR, exist_ok=True)

    # Save the certificate (public) and private key (secret) to local files.
    cert_path = os.path.join(CERTS_DIR, f"{camera_id}.cert.pem")
    key_path = os.path.join(CERTS_DIR, f"{camera_id}.private.key")

    with open(cert_path, "w") as f:
        f.write(cert_response["certificatePem"])
    with open(key_path, "w") as f:
        f.write(cert_response["keyPair"]["PrivateKey"])

    print(f"[2/4] Certificate created and saved:")
    print(f"        {cert_path}")
    print(f"        {key_path}  (KEEP SECRET)")

    # ------------------------------------------------------------------
    # Step 3: Create an IoT policy scoped to THIS camera only.
    # The policy allows connecting and publishing ONLY to this camera's
    # own heartbeat topic — not any other camera's. (Least privilege.)
    # ------------------------------------------------------------------
    account_id = boto3.client("sts").get_caller_identity()["Account"]
    topic = f"cameras/{site_id}/{camera_id}/heartbeat"

    policy_name = f"camera-policy-{camera_id}"
    policy_document = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": "iot:Connect",
                "Resource": f"arn:aws:iot:{REGION}:{account_id}:client/{camera_id}",
            },
            {
                "Effect": "Allow",
                "Action": "iot:Publish",
                "Resource": f"arn:aws:iot:{REGION}:{account_id}:topic/{topic}",
            },
        ],
    }

    try:
        iot.create_policy(
            policyName=policy_name,
            policyDocument=json.dumps(policy_document),
        )
        print(f"[3/4] Policy created: {policy_name}")
        print(f"        Camera may publish ONLY to: {topic}")
    except iot.exceptions.ResourceAlreadyExistsException:
        print(f"[3/4] Policy already exists: {policy_name} (skipping)")

    # ------------------------------------------------------------------
    # Step 4: Wire it all together.
    # ------------------------------------------------------------------
    iot.attach_policy(policyName=policy_name, target=cert_arn)
    iot.attach_thing_principal(thingName=thing_name, principal=cert_arn)
    print(f"[4/4] Policy attached to certificate, certificate attached to Thing.")

    print(f"\n=== Done. Certificate ID: {cert_id} ===")
    print(f"Certs saved in ./{CERTS_DIR}/  (gitignored)\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Provision a simulated camera in AWS IoT Core")
    parser.add_argument("--camera-id", required=True, help="Unique camera ID, e.g. CAM-001")
    parser.add_argument("--site-id", required=True, help="Site ID, e.g. boca-01")
    args = parser.parse_args()

    provision(args.camera_id, args.site_id)