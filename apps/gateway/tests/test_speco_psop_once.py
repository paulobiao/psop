from __future__ import annotations

import sys
import unittest
from pathlib import Path

DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIR))

from speco_n8nrl import build_psop_recorder_observations


MAPPING = {
    "recorder": {
        "deviceId": "00000000-0000-4000-8000-000000000010",
    },
    "channels": {
        "channel-1": {
            "deviceId": "00000000-0000-4000-8000-000000000011",
        }
    },
}


class SpecoPsopOnceTests(unittest.TestCase):
    def test_verified_channel_maps_to_psop_observation(self):
        result = {
            "statusSourceAvailable": True,
            "onlineChannelIds": ["channel-1"],
            "channels": [
                {
                    "channelId": "channel-1",
                    "channelNumber": 1,
                    "individualVerification": "RECORDER_VERIFIED",
                    "operationalState": "ONLINE",
                    "protocol": "ONVIF",
                    "model": "DS-2CD2122FWD-IS",
                    "firmware": None,
                    "recordingAvailability":
                        "NOT_AVAILABLE_NO_STORAGE",
                    "poe": {
                        "displayPort": 1,
                        "powerW": 3.19,
                    },
                    "recordingStreams": [
                        {
                            "streamType": "main",
                            "bitrateKbps": 3072,
                            "resolution": "1920x1080",
                            "frameRate": 30,
                        }
                    ],
                }
            ],
        }

        observations, unmapped = (
            build_psop_recorder_observations(
                result,
                MAPPING,
            )
        )

        self.assertEqual(unmapped, [])
        self.assertEqual(len(observations), 1)

        observation = observations[0]
        self.assertEqual(
            observation["deviceId"],
            "00000000-0000-4000-8000-000000000011",
        )
        self.assertEqual(observation["status"], "online")
        self.assertEqual(observation["poePort"], 1)
        self.assertEqual(observation["poePowerW"], 3.19)
        self.assertEqual(
            observation["recordingStatus"],
            "NOT_AVAILABLE_NO_STORAGE",
        )
        self.assertEqual(
            observation["resolution"],
            "1920x1080",
        )

    def test_offline_membership_becomes_authoritative_offline(self):
        result = {
            "statusSourceAvailable": True,
            "onlineChannelIds": [],
            "channels": [
                {
                    "channelId": "channel-1",
                    "channelNumber": 1,
                    "individualVerification": "RECORDER_VERIFIED",
                    "operationalState": "OFFLINE",
                    "poe": {
                        "displayPort": 1,
                        "powerW": 0.0,
                    },
                    "recordingStreams": [],
                }
            ],
        }

        observations, _ = build_psop_recorder_observations(
            result,
            MAPPING,
        )

        self.assertEqual(observations[0]["status"], "offline")
        self.assertEqual(observations[0]["poePowerW"], 0.0)

    def test_expected_unplugged_channel_missing_from_device_list_is_offline(self):
        mapping = {
            "recorder": {
                "deviceId": "00000000-0000-4000-8000-000000000010",
            },
            "channels": {
                "channel-1": {
                    "deviceId":
                        "00000000-0000-4000-8000-000000000011",
                    "channelNumber": 1,
                },
                "channel-2": {
                    "deviceId":
                        "00000000-0000-4000-8000-000000000012",
                    "channelNumber": 2,
                },
            },
        }

        result = {
            "statusSourceAvailable": True,
            "onlineChannelIds": ["channel-1"],
            "channels": [
                {
                    "channelId": "channel-1",
                    "channelNumber": 1,
                    "individualVerification": "RECORDER_VERIFIED",
                    "operationalState": "ONLINE",
                    "recordingStreams": [],
                }
            ],
            "poe": {
                "ports": [
                    {
                        "displayPort": 1,
                        "powerW": 3.2,
                    },
                    {
                        "displayPort": 2,
                        "powerW": 0.0,
                    },
                ]
            },
        }

        observations, unmapped = (
            build_psop_recorder_observations(
                result,
                mapping,
            )
        )

        self.assertEqual(unmapped, [])
        self.assertEqual(len(observations), 2)

        by_device = {
            item["deviceId"]: item
            for item in observations
        }

        offline = by_device[
            "00000000-0000-4000-8000-000000000012"
        ]
        self.assertEqual(offline["status"], "offline")
        self.assertEqual(offline["channelId"], "channel-2")
        self.assertEqual(offline["channelNumber"], 2)
        self.assertEqual(offline["poePort"], 2)
        self.assertEqual(offline["poePowerW"], 0.0)

    def test_unavailable_status_source_sends_no_child_assertions(self):
        result = {
            "statusSourceAvailable": False,
            "channels": [
                {
                    "channelId": "channel-1",
                    "individualVerification": "NOT_VERIFIED",
                    "operationalState": "UNKNOWN",
                }
            ],
        }

        observations, unmapped = (
            build_psop_recorder_observations(
                result,
                MAPPING,
            )
        )

        self.assertEqual(observations, [])
        self.assertEqual(unmapped, [])


if __name__ == "__main__":
    unittest.main()
