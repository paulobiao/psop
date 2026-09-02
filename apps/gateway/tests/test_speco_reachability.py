from __future__ import annotations

import sys
import unittest
from pathlib import Path

DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIR))

from speco_n8nrl import SpecoError, SpecoNRLClient


def _client() -> SpecoNRLClient:
    client = object.__new__(SpecoNRLClient)
    client.host = "127.0.0.1"
    return client


def _reachable_core(client: SpecoNRLClient) -> None:
    client.query_basic_cfg = lambda: {"name": "NVR Speco"}
    client.query_online_channel_ids = lambda: {"channel-1"}
    client.query_device_list = lambda: [
        {
            "channelId": "channel-1",
            "channelNumber": 1,
            "poeIndex": 1,
            "protocol": "ONVIF",
        }
    ]
    client.query_channel_status = lambda: {}
    client.query_recording_status = lambda: {}
    client.query_poe_power = lambda: {
        "totalPowerW": 96.0,
        "remainingPowerW": 92.0,
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
    client.query_channel_firmware = lambda _cid: None


class SpecoReachabilityTests(unittest.TestCase):
    def test_all_core_calls_failing_marks_recorder_unreachable(self):
        """Test 1: NVR fisicamente inacessível -> nenhuma core source
        responde -> recorderReachable=False, status UNREACHABLE."""
        client = _client()

        def down(*_a, **_k):
            raise SpecoError(
                "queryX failed: <urlopen error [Errno 65] "
                "No route to host>"
            )

        client.query_basic_cfg = down
        client.query_online_channel_ids = down
        client.query_device_list = down
        client.query_channel_status = down
        client.query_recording_status = down
        client.query_poe_power = down
        client.query_storage = down
        client.query_channel_firmware = lambda _cid: None

        result = client.collect()

        self.assertFalse(result["recorderReachable"])
        self.assertEqual(result["status"], "UNREACHABLE")
        self.assertEqual(result["coreSourcesSucceeded"], [])
        self.assertEqual(len(result["coreSourcesFailed"]), 7)
        self.assertFalse(result["statusSourceAvailable"])
        self.assertIsNone(result["onlineChannelIds"])
        self.assertEqual(result["channels"], [])

    def test_one_core_failure_with_a_surviving_core_stays_reachable(self):
        """Test 2: uma core falha, outra core responde -> reachable=True,
        collection PARTIAL, heartbeat ONLINE permitido."""
        client = _client()
        _reachable_core(client)

        def down():
            raise SpecoError("queryStorageDevInfo failed: timeout")

        client.query_storage = down

        result = client.collect()

        self.assertTrue(result["recorderReachable"])
        self.assertEqual(result["status"], "PARTIAL")
        self.assertIn("queryStorageDevInfo", result["coreSourcesFailed"])
        self.assertIn("queryBasicCfg", result["coreSourcesSucceeded"])
        self.assertIn("queryOnlineChlList", result["coreSourcesSucceeded"])
        self.assertTrue(result["statusSourceAvailable"])

    def test_optional_channel_info_failure_keeps_recorder_reachable(self):
        """Test 3: apenas o enrichment opcional queryIPChlInfo falha ->
        reachable=True, collection PASSED, heartbeat permitido.

        Enrichment opcional NUNCA e prova de reachability e nunca pode
        rebaixar recorderReachable."""
        client = _client()
        _reachable_core(client)

        def optional_down(_cid):
            raise SpecoError(
                "queryIPChlInfo failed with errorCode=536870962"
            )

        client.query_channel_firmware = optional_down

        result = client.collect()

        self.assertTrue(result["recorderReachable"])
        self.assertEqual(result["status"], "PASSED")
        self.assertEqual(result["errors"], [])
        self.assertEqual(len(result["optionalGaps"]), 1)
        self.assertTrue(
            result["optionalGaps"][0]["source"].startswith(
                "cameraFirmware:"
            )
        )
        self.assertEqual(len(result["coreSourcesSucceeded"]), 7)
        self.assertEqual(result["coreSourcesFailed"], [])


if __name__ == "__main__":
    unittest.main()
