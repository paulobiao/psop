from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIR))

from psop_gateway import ProbeConfig, normalize_mac, probe_icmp


class Completed:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class IcmpProbeTests(unittest.TestCase):
    def test_normalize_mac_zero_pads_octets(self):
        self.assertEqual(
            normalize_mac("a0:9f:10:a:15:e6"),
            "a0:9f:10:0a:15:e6",
        )

    @patch("psop_gateway.resolve_neighbor_mac")
    @patch("psop_gateway.subprocess.run")
    def test_icmp_with_matching_mac_is_verified(
        self,
        run_mock,
        mac_mock,
    ):
        run_mock.return_value = Completed(returncode=0)
        mac_mock.return_value = "a0:9f:10:0a:15:e6"

        result = probe_icmp(
            ProbeConfig(
                name="lorex-home-center",
                probe_type="icmp",
                host="192.0.2.10",
                expected_mac="a0:9f:10:a:15:e6",
            ),
            2.0,
        )

        self.assertTrue(result.success)
        self.assertIn("MAC verified", result.detail)

    @patch("psop_gateway.resolve_neighbor_mac")
    @patch("psop_gateway.subprocess.run")
    def test_icmp_with_wrong_mac_fails_identity_check(
        self,
        run_mock,
        mac_mock,
    ):
        run_mock.return_value = Completed(returncode=0)
        mac_mock.return_value = "00:11:22:33:44:55"

        result = probe_icmp(
            ProbeConfig(
                name="lorex-home-center",
                probe_type="icmp",
                host="192.0.2.10",
                expected_mac="a0:9f:10:0a:15:e6",
            ),
            2.0,
        )

        self.assertFalse(result.success)
        self.assertIn("MAC identity mismatch", result.detail)


if __name__ == "__main__":
    unittest.main()
