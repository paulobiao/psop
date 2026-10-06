import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from stream_evidence import sanitize_discovered_endpoint


class StreamSanitizationTests(unittest.TestCase):
    def test_credentials_and_arbitrary_path_query_fragment_are_not_retained(self):
        result = sanitize_discovered_endpoint(
            'rtsp://username:password@192.0.2.1:8554/secret-path?token=secret-token#secret-fragment',
            'secret-profile', 'ONVIF_GET_STREAM_URI', 1)
        serialized = json.dumps(result)
        for secret in ['username', 'password', 'secret-path', 'secret-token', 'secret-fragment', 'secret-profile', 'rtsp://']:
            self.assertNotIn(secret, serialized)
        self.assertEqual(result['port'], 8554)
        self.assertEqual(len(result['pathSha256']), 64)

    def test_ipv6_and_rtsps(self):
        result = sanitize_discovered_endpoint('rtsps://[2001:db8::1]/video', 'main', 'VENDOR_API')
        self.assertEqual(result['host'], '2001:db8::1')
        self.assertEqual(result['port'], 322)

    def test_invalid_endpoints_have_constant_secret_free_errors(self):
        for uri in ['rtsp://secret.example/path', 'http://192.0.2.1/secret', 'rtsp://192.0.2.1:99999/secret', 'rtsp://[secret', 'rtsp://192.0.2.1/\nsecret', 'rtsp://192.0.2.1:0/secret']:
            with self.subTest(uri_index=len(uri)):
                with self.assertRaisesRegex(ValueError, '^Unsafe or unsupported stream endpoint$'):
                    sanitize_discovered_endpoint(uri, 'main', 'VENDOR_API')

    def test_configuration_is_not_discovery(self):
        with self.assertRaises(ValueError):
            sanitize_discovered_endpoint('rtsp://192.0.2.1/video', 'main', 'CONFIGURED')
