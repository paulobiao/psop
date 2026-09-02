from __future__ import annotations

import sys
import unittest
from pathlib import Path

DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIR))

from speco_n8nrl import PsopRecorderApiClient


class CapturingClient(PsopRecorderApiClient):
    def __init__(self):
        super().__init__("http://api.local", "rec-1", "key-1", 5.0)
        self.captured: dict = {}

    def _post(self, path, payload):
        self.captured = {"path": path, "payload": payload}
        return {"ok": True}


BASE_RESULT = {
    "observedAtEpoch": 1_700_000_000,
    "recorder": {"model": "N8NRL", "firmware": "1.0.0"},
    "poe": {"totalPowerW": 96.0, "remainingPowerW": 92.0, "ports": []},
    "channels": [{"channelId": "c1"}, {"channelId": "c2"}, {"channelId": "c3"}],
    "onlineChannelIds": ["c1", "c2", "c3"],
    "errors": [],
    "optionalGaps": [],
    "status": "PASSED",
}


class SpecoRecorderHealthTests(unittest.TestCase):
    def test_no_hdd_recorder_stays_online_with_capabilities(self):
        client = CapturingClient()
        client.send_recorder(
            {
                **BASE_RESULT,
                "storage": {"present": False, "state": "NOT_INSTALLED", "disks": []},
            }
        )

        payload = client.captured["payload"]
        self.assertEqual(payload["status"], "online")
        self.assertEqual(payload["collectionState"], "COMPLETE")
        self.assertEqual(payload["collectionIssues"], [])
        self.assertEqual(
            payload["capabilities"]["storage"]["state"], "NOT_INSTALLED"
        )
        self.assertFalse(payload["capabilities"]["storage"]["present"])
        self.assertEqual(
            payload["capabilities"]["recording"]["state"],
            "NOT_AVAILABLE_NO_STORAGE",
        )

    def test_partial_core_collection_does_not_degrade_recorder(self):
        client = CapturingClient()
        client.send_recorder(
            {
                **BASE_RESULT,
                "status": "PARTIAL",
                "storage": {"present": None, "state": "UNKNOWN", "disks": []},
                "errors": [
                    {"source": "queryStorageDevInfo", "error": "SpecoError: timeout"}
                ],
            }
        )

        payload = client.captured["payload"]
        self.assertEqual(payload["status"], "online")
        self.assertEqual(payload["collectionState"], "PARTIAL")
        self.assertEqual(
            payload["collectionIssues"][0]["code"], "COLLECTION_SOURCE_FAILED"
        )

    def test_optional_firmware_gap_makes_collection_partial_not_a_failure(self):
        client = CapturingClient()
        client.send_recorder(
            {
                **BASE_RESULT,
                "storage": {"present": False, "state": "NOT_INSTALLED", "disks": []},
                "optionalGaps": [
                    {
                        "source": "cameraFirmware:c1",
                        "error": "SpecoError: errorCode=536870962",
                    }
                ],
            }
        )

        payload = client.captured["payload"]
        # The recorder itself stays online — an optional gap is not a core
        # failure — but the collection was not COMPLETE.
        self.assertEqual(payload["status"], "online")
        self.assertEqual(payload["collectionState"], "PARTIAL")
        self.assertEqual(
            payload["collectionIssues"][0]["code"],
            "OPTIONAL_ENRICHMENT_UNAVAILABLE",
        )


if __name__ == "__main__":
    unittest.main()
