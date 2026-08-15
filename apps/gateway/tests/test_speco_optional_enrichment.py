from __future__ import annotations

import sys
import unittest
from pathlib import Path

DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIR))

from speco_n8nrl import SpecoError, SpecoNRLClient


class SpecoOptionalEnrichmentTests(unittest.TestCase):
    def test_firmware_enrichment_failure_keeps_core_collection_passed(self):
        client = object.__new__(SpecoNRLClient)
        client.host = "127.0.0.1"

        client.query_basic_cfg = lambda: {"name": "NVR Speco"}
        client.query_online_channel_ids = lambda: {"channel-1"}
        client.query_device_list = lambda: [
            {
                "channelId": "channel-1",
                "channelNumber": 1,
                "poeIndex": 1,
                "protocol": "ONVIF",
                "model": "DS-2CD2122FWD-IS",
            }
        ]
        client.query_channel_status = lambda: {}
        client.query_recording_status = lambda: {}
        client.query_poe_power = lambda: {
            "totalPowerW": 96.0,
            "remainingPowerW": 92.8,
            "ports": [
                {
                    "rawIndex": 0,
                    "displayPort": 1,
                    "enabled": True,
                    "powerW": 3.2,
                }
            ],
        }
        client.query_storage = lambda: {
            "present": False,
            "state": "NOT_INSTALLED",
            "disks": [],
        }

        def unavailable_firmware(_channel_id):
            raise SpecoError("optional permission unavailable")

        client.query_channel_firmware = unavailable_firmware

        result = client.collect()

        self.assertEqual(result["status"], "PASSED")
        self.assertEqual(result["errors"], [])
        self.assertEqual(len(result["optionalGaps"]), 1)
        self.assertTrue(
            result["optionalGaps"][0]["source"].startswith(
                "queryIPChlInfo:"
            )
        )
        self.assertIsNone(result["channels"][0]["firmware"])
        self.assertEqual(
            result["channels"][0]["individualVerification"],
            "RECORDER_VERIFIED",
        )
        self.assertEqual(
            result["channels"][0]["operationalState"],
            "ONLINE",
        )
        self.assertEqual(
            result["channels"][0]["recordingAvailability"],
            "NOT_AVAILABLE_NO_STORAGE",
        )


if __name__ == "__main__":
    unittest.main()
