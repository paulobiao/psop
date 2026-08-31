from __future__ import annotations

import hashlib
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
import xml.etree.ElementTree as ET

DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIR))

from speco_n8nrl import SpecoError, SpecoLoginError, SpecoNRLClient, build_request, compute_login_digest


def xml(text: str) -> ET.Element:
    return ET.fromstring(text)


class SpecoNRLTests(unittest.TestCase):
    def test_login_digest_matches_firmware_formula(self):
        password = "Secret123"
        nonce = "abc123"
        pem = "-----BEGIN PUBLIC KEY-----\\r\\nTEST\\r\\n-----END PUBLIC KEY-----\\r\\n"
        md5_upper = hashlib.md5(password.encode()).hexdigest().upper()
        expected = hashlib.sha512(f"{md5_upper}#{nonce}#{pem.replace(chr(13), '')}".encode()).hexdigest()
        self.assertEqual(compute_login_digest(password, nonce, pem), expected)

    def test_pre_auth_request_uses_literal_null_token(self):
        request = build_request()

        self.assertIn("<token>null</token>", request)
        self.assertNotIn("<token></token>", request)

    def test_request_header_matches_nvms_web_protocol(self):
        request = build_request("token-1", "<content/>", refresh=False)
        self.assertIn('version="1.0"', request)
        self.assertIn('systemType="NVMS-9000"', request)
        self.assertIn('clientType="WEB"', request)
        self.assertIn('refresh = "false"', request)
        self.assertIn("<token>token-1</token>", request)

    def test_mutating_command_is_refused(self):
        client = SpecoNRLClient("127.0.0.1")
        with self.assertRaises(SpecoError):
            client._assert_safe("editPoePower")

    def test_device_list_request_does_not_ask_for_credentials(self):
        captured = {}
        def transport(command, body):
            captured["command"] = command
            captured["body"] = body
            return xml("<response><status>success</status><content/></response>")
        client = SpecoNRLClient("127.0.0.1", transport=transport)
        client.session = type("S", (), {"session_id": "s", "token": "t"})()
        client.query_device_list()
        self.assertEqual(captured["command"], "queryDevList")
        self.assertNotIn("<userName/>", captured["body"])
        self.assertNotIn("<password/>", captured["body"])

    def test_online_membership_is_authoritative_in_collect(self):
        responses = {
            "queryBasicCfg": "<response><status>success</status><content><model>N8NRL</model></content></response>",
            "queryOnlineChlList": "<response><status>success</status><content><item id='{00000001-0000-0000-0000-000000000000}'/></content></response>",
            "queryDevList": "<response><status>success</status><content>"
                "<item id='{00000001-0000-0000-0000-000000000000}'><name>Hikvision 01</name><chlNum>1</chlNum><poeIndex>1</poeIndex><protocolType>ONVIF</protocolType><productModel>DS-2CD2123G0-I</productModel></item>"
                "<item id='{00000002-0000-0000-0000-000000000000}'><name>Hikvision 02</name><chlNum>2</chlNum><poeIndex>2</poeIndex><protocolType>ONVIF</protocolType><productModel>DS-2CD2122FWD-IS</productModel></item>"
                "</content></response>",
            "queryChlStatus": "<response><status>success</status><content><item><chl id='{00000001-0000-0000-0000-000000000000}'>Hikvision 01</chl><online>true</online><recStatus>recordingAbnormal</recStatus></item></content></response>",
            "queryRecStatus": "<response><status>success</status><content/></response>",
            "queryPoePower": "<response><status>success</status><content><totalPower>96.00</totalPower><remainPower>92.00</remainPower><poePort><item index='0'><switch>true</switch><power>3.20</power></item><item index='1'><switch>true</switch><power>0</power></item></poePort></content></response>",
            "queryStorageDevInfo": "<response><status>success</status><content><diskList/></content></response>",
        }
        def transport(command, body):
            if command == "queryIPChlInfo":
                return xml("<response><status>success</status><content><chl><detailedSoftwareVersion/></chl></content></response>")
            return xml(responses[command])
        client = SpecoNRLClient("127.0.0.1", transport=transport)
        client.session = type("S", (), {"session_id": "s", "token": "t"})()
        result = client.collect()
        by_name = {item["name"]: item for item in result["channels"]}
        self.assertEqual(by_name["Hikvision 01"]["operationalState"], "ONLINE")
        self.assertEqual(by_name["Hikvision 02"]["operationalState"], "OFFLINE")
        self.assertEqual(by_name["Hikvision 02"]["individualVerification"], "RECORDER_VERIFIED")

    def test_empty_disk_list_is_not_installed(self):
        def transport(command, body):
            return xml("<response><status>success</status><content><diskList/></content></response>")
        client = SpecoNRLClient("127.0.0.1", transport=transport)
        client.session = type("S", (), {"session_id": "s", "token": "t"})()
        result = client.query_storage()
        self.assertFalse(result["present"])
        self.assertEqual(result["state"], "NOT_INSTALLED")

    def test_poe_raw_index_is_zero_based_and_display_port_is_one_based(self):
        def transport(command, body):
            return xml("<response><status>success</status><content><totalPower>96.00</totalPower><remainPower>92.81</remainPower><poePort><item index='0'><switch>true</switch><power>3.19</power></item></poePort></content></response>")
        client = SpecoNRLClient("127.0.0.1", transport=transport)
        client.session = type("S", (), {"session_id": "s", "token": "t"})()
        result = client.query_poe_power()
        self.assertEqual(result["ports"][0]["rawIndex"], 0)
        self.assertEqual(result["ports"][0]["displayPort"], 1)
        self.assertEqual(result["ports"][0]["powerW"], 3.19)

    def test_no_storage_normalizes_recording_abnormal(self):
        responses = {
            "queryBasicCfg": "<response><status>success</status><content><model>N8NRL</model></content></response>",
            "queryOnlineChlList": "<response><status>success</status><content><item id='{00000001-0000-0000-0000-000000000000}'/></content></response>",
            "queryDevList": "<response><status>success</status><content><item id='{00000001-0000-0000-0000-000000000000}'><name>Hikvision 01</name><chlNum>1</chlNum><poeIndex>1</poeIndex></item></content></response>",
            "queryChlStatus": "<response><status>success</status><content><item><chl id='{00000001-0000-0000-0000-000000000000}'>Hikvision 01</chl><online>true</online><recStatus>recordingAbnormal</recStatus></item></content></response>",
            "queryRecStatus": "<response><status>success</status><content/></response>",
            "queryPoePower": "<response><status>success</status><content><poePort/></content></response>",
            "queryStorageDevInfo": "<response><status>success</status><content><diskList/></content></response>",
        }
        def transport(command, body):
            if command == "queryIPChlInfo":
                return xml("<response><status>success</status><content><chl/></content></response>")
            return xml(responses[command])
        client = SpecoNRLClient("127.0.0.1", transport=transport)
        client.session = type("S", (), {"session_id": "s", "token": "t"})()
        camera = client.collect()["channels"][0]
        self.assertEqual(camera["rawRecordingStatus"], "recordingAbnormal")
        self.assertEqual(camera["recordingAvailability"], "NOT_AVAILABLE_NO_STORAGE")

    @patch("speco_n8nrl.generate_rsa_public_pem")
    def test_failed_login_performs_only_one_do_login_attempt(self, generate_key):
        generate_key.return_value = "-----BEGIN PUBLIC KEY-----\\r\\nTEST\\r\\n-----END PUBLIC KEY-----\\r\\n"
        calls = []
        def transport(command, body):
            calls.append(command)
            if command == "reqLogin":
                return xml("<response><status>success</status><content><nonce>abc</nonce><sessionId>{session-1}</sessionId></content></response>")
            if command == "doLogin":
                return xml("<response><status>failed</status><errorCode>536870947</errorCode><ramainingNumber>4</ramainingNumber><ramainingTime>0</ramainingTime><locked>false</locked></response>")
            raise AssertionError(command)
        client = SpecoNRLClient("127.0.0.1", transport=transport)
        with self.assertRaises(SpecoLoginError) as caught:
            client.login("admin", "wrong")
        self.assertEqual(calls, ["reqLogin", "doLogin"])
        self.assertEqual(caught.exception.remaining_attempts, 4)
        self.assertFalse(caught.exception.locked)
    def test_status_source_failure_never_synthesizes_camera_offline(self):
        client = object.__new__(SpecoNRLClient)
        client.host = "127.0.0.1"

        client.query_basic_cfg = lambda: {}
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
        client.query_channel_firmware = lambda _channel_id: None

        def unavailable_status_source():
            raise SpecoError("queryOnlineChlList unavailable")

        client.query_online_channel_ids = unavailable_status_source

        result = client.collect()

        self.assertEqual(result["status"], "PARTIAL")
        self.assertFalse(result["statusSourceAvailable"])
        self.assertIsNone(result["onlineChannelIds"])

        channel = result["channels"][0]
        self.assertIsNone(channel["online"])
        self.assertEqual(channel["operationalState"], "UNKNOWN")
        self.assertEqual(
            channel["individualVerification"],
            "NOT_VERIFIED",
        )
        self.assertEqual(
            channel["verificationMethod"],
            "RECORDER_STATUS_UNAVAILABLE",
        )

        self.assertTrue(
            any(
                error["source"] == "queryOnlineChlList"
                for error in result["errors"]
            )
        )



if __name__ == "__main__":
    unittest.main()
