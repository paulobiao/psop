from __future__ import annotations

import sys
import unittest
from pathlib import Path

DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIR))

from child_device_discovery import (
    ChildDeviceDiscoveryEngine,
    HikvisionIsapiProvider,
)
from speco_n8nrl import enrich_discovered_children


class SpecoChildDiscoveryIntegrationTests(unittest.TestCase):
    def test_recorder_proxy_enriches_firmware(self):
        def fake_fetch(url, credential, timeout):
            self.assertEqual(
                url,
                "http://192.0.2.20:59101/ISAPI/System/deviceInfo",
            )
            self.assertEqual(
                credential.username,
                "monitor",
            )
            self.assertGreaterEqual(timeout, 0.5)
            return (
                b"<DeviceInfo>"
                b"<model>DS-2CD2123G0-I</model>"
                b"<firmwareVersion>V5.6.6</firmwareVersion>"
                b"<firmwareReleasedDate>build 210625</firmwareReleasedDate>"
                b"</DeviceInfo>"
            )

        engine = ChildDeviceDiscoveryEngine(
            providers=[
                HikvisionIsapiProvider(
                    fetcher=fake_fetch
                )
            ]
        )

        result = {
            "channels": [
                {
                    "channelId": "channel-1",
                    "name": "Hikvision 01",
                    "model": "DS-2CD2123G0-I",
                    "manufacturerReported": "ONVIF",
                    "protocol": "ONVIF",
                    "poePortReported": 59101,
                    "firmware": None,
                }
            ],
            "optionalGaps": [
                {
                    "source": "cameraFirmware:channel-1",
                    "error": "optional recorder gap",
                }
            ],
        }

        enriched = enrich_discovered_children(
            result,
            recorder_host="192.0.2.20",
            local_env={
                "PSOP_HIKVISION_USERNAME": "monitor",
                "PSOP_HIKVISION_PASSWORD": "secret",
            },
            timeout=3.0,
            engine=engine,
        )

        channel = enriched["channels"][0]

        self.assertEqual(
            channel["firmware"],
            "V5.6.6 build 210625",
        )
        self.assertEqual(
            channel["discovery"]["endpoint"]["port"],
            59101,
        )
        self.assertEqual(
            channel["discovery"]["status"],
            "ENRICHED",
        )
        self.assertEqual(
            enriched["childDiscovery"]["enriched"],
            1,
        )
        self.assertEqual(
            enriched["optionalGaps"],
            [],
        )


if __name__ == "__main__":
    unittest.main()
