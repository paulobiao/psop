from __future__ import annotations

import sys
import unittest
from pathlib import Path

DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIR))

from child_device_discovery import (
    ChildDeviceDiscoveryEngine,
    DeviceCandidate,
    DeviceCredential,
    DiscoveredEndpoint,
    HikvisionIsapiProvider,
)


class ChildDeviceDiscoveryTests(unittest.TestCase):
    def candidate(self) -> DeviceCandidate:
        return DeviceCandidate(
            channel_id="channel-1",
            name="Hikvision 01",
            model="DS-2CD2123G0-I",
            manufacturer="ONVIF",
            protocol="ONVIF",
            endpoint=DiscoveredEndpoint(
                scheme="http",
                host="192.0.2.10",
                port=59101,
                via="RECORDER_PROXY",
                source="RECORDER_REPORTED_PROXY",
            ),
        )

    def test_hikvision_provider_parses_only_safe_device_info(self):
        calls = []

        def fake_fetch(url, credential, timeout):
            calls.append(
                (
                    url,
                    credential.username,
                    timeout,
                )
            )
            return b"""<?xml version="1.0"?>
<DeviceInfo xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <deviceName>IP CAMERA</deviceName>
  <model>DS-2CD2123G0-I</model>
  <serialNumber>DO-NOT-RETURN</serialNumber>
  <firmwareVersion>V5.6.6</firmwareVersion>
  <firmwareReleasedDate>build 210625</firmwareReleasedDate>
  <hardwareVersion>0x0</hardwareVersion>
</DeviceInfo>"""

        provider = HikvisionIsapiProvider(
            fetcher=fake_fetch
        )
        result = provider.enrich(
            self.candidate(),
            DeviceCredential(
                username="monitor",
                password="secret",
            ),
            3.0,
        )

        self.assertEqual(result.status, "ENRICHED")
        self.assertEqual(
            result.firmware,
            "V5.6.6 build 210625",
        )
        self.assertEqual(
            result.model,
            "DS-2CD2123G0-I",
        )
        self.assertNotIn(
            "DO-NOT-RETURN",
            str(result.public_dict()),
        )
        self.assertEqual(len(calls), 1)

    def test_missing_credentials_is_not_a_core_failure(self):
        provider = HikvisionIsapiProvider(
            fetcher=lambda *_args: b""
        )
        result = provider.enrich(
            self.candidate(),
            None,
            3.0,
        )

        self.assertEqual(
            result.status,
            "CREDENTIAL_REQUIRED",
        )
        self.assertIsNone(result.firmware)

    def test_engine_caches_successful_enrichment(self):
        count = 0

        def fake_fetch(_url, _credential, _timeout):
            nonlocal count
            count += 1
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
            ],
            success_ttl_seconds=900,
        )
        credentials = {
            "hikvision": DeviceCredential(
                "monitor",
                "secret",
            )
        }

        first = engine.enrich(
            self.candidate(),
            credentials,
            3.0,
        )
        second = engine.enrich(
            self.candidate(),
            credentials,
            3.0,
        )

        self.assertEqual(first.status, "ENRICHED")
        self.assertEqual(second.status, "ENRICHED")
        self.assertEqual(count, 1)


if __name__ == "__main__":
    unittest.main()
