"""Synthetic protocol fixtures only. Never loads lab files or contacts hardware."""
from __future__ import annotations

import base64
import contextlib
import copy
import hashlib
import io
import json
import socket
import struct
import sys
import tempfile
import time
import unittest
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.request import parse_http_list, parse_keqv_list

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from onvif_stream import DEVICE, MEDIA, SOAP, TT, WSSE, WSU, OnvifDiscovery
from rtsp_stream import RtspProbe, rtp_video
from stream_probe_common import Budget, Credentials, ProbeError, authorization, checked_url, http_post
import stream_probe

SECRET = 'fixture-only-secret'
USER = 'fixture-only-user'
SERIAL = 'fixture-only-camera-serial'
PROFILE = 'fixture-only-profile'
URI = f'rtsp://127.0.0.1:8554/{SECRET}?token={SECRET}'
CREDENTIALS = Credentials(USER, SECRET)
CONFIG = {
    'probeId': '22222222-2222-4222-8222-222222222222',
    'deviceId': '11111111-1111-4111-8111-111111111111',
    'observerId': '33333333-3333-4333-8333-333333333333',
    'channelId': 'channel-1', 'channelNumber': 1,
    'onvifDeviceService': 'http://127.0.0.1/onvif/device_service',
    'expectedSerialSha256': hashlib.sha256(SERIAL.encode()).hexdigest(),
}
MAPPING = {'recorder': {'deviceId': CONFIG['observerId']},
           'channels': {'channel-1': {'deviceId': CONFIG['deviceId'], 'channelNumber': 1}}}


def packet(pt=96, ssrc=123, payload=b'\x65\x00\x01', flags=0x80):
    return struct.pack('!BBHII', flags, pt, 1, 9000, ssrc) + payload


def interleaved(channel, payload):
    return b'$' + struct.pack('!BH', channel, len(payload)) + payload


class SoapFixture:
    def __init__(self, uri=URI, *, fail=None, multi_source=False, address=None, auth=False):
        self.uri, self.fail, self.multi_source, self.address = uri, fail, multi_source, address
        self.auth = auth
        self.authenticated = []
        self.calls = []

    def __call__(self, url, data, headers, budget):
        if self.auth and 'Authorization' not in headers:
            return 401, {'www-authenticate': 'Digest realm="soap", nonce="nonce", qop="auth"'}, b''
        if 'Authorization' in headers:
            self.authenticated.append(headers['Authorization'])
            assert SECRET not in headers['Authorization']
        request = ET.fromstring(data)
        username = request.findtext(f'.//{{{WSSE}}}Username')
        nonce = base64.b64decode(request.findtext(f'.//{{{WSSE}}}Nonce'))
        created = request.findtext(f'.//{{{WSU}}}Created')
        digest = request.findtext(f'.//{{{WSSE}}}Password')
        assert username == USER
        assert digest == base64.b64encode(hashlib.sha1(nonce + created.encode() + SECRET.encode()).digest()).decode()
        assert SECRET.encode() not in data
        command = list(request.find(f'{{{SOAP}}}Body'))[0]
        namespace, name = command.tag[1:].split('}')
        self.calls.append(name)
        if self.fail == name:
            return 403, {}, b''
        envelope = ET.Element(f'{{{SOAP}}}Envelope')
        body = ET.SubElement(envelope, f'{{{SOAP}}}Body')
        reply = ET.SubElement(body, f'{{{namespace}}}{name}Response')
        if name == 'GetDeviceInformation':
            ET.SubElement(reply, f'{{{DEVICE}}}Manufacturer').text = 'HIKVISION'
            ET.SubElement(reply, f'{{{DEVICE}}}SerialNumber').text = SERIAL
        elif name == 'GetCapabilities':
            caps = ET.SubElement(reply, f'{{{DEVICE}}}Capabilities')
            media = ET.SubElement(caps, f'{{{TT}}}Media')
            ET.SubElement(media, f'{{{TT}}}XAddr').text = self.address or url
        elif name == 'GetProfiles':
            for index in range(2 if self.multi_source else 1):
                profile = ET.SubElement(reply, f'{{{MEDIA}}}Profiles', {'token': PROFILE + (str(index) if index else '')})
                source = ET.SubElement(profile, f'{{{TT}}}VideoSourceConfiguration')
                ET.SubElement(source, f'{{{TT}}}SourceToken').text = f'camera-{index}'
                ET.SubElement(profile, f'{{{TT}}}VideoEncoderConfiguration')
        elif name == 'GetStreamUri':
            assert command.findtext(f'{{{MEDIA}}}ProfileToken') == PROFILE
            assert command.findtext(f'{{{MEDIA}}}StreamSetup/{{{TT}}}Stream') == 'RTP-Unicast'
            assert command.findtext(f'{{{MEDIA}}}StreamSetup/{{{TT}}}Transport/{{{TT}}}Protocol') == 'RTSP'
            media = ET.SubElement(reply, f'{{{MEDIA}}}MediaUri')
            ET.SubElement(media, f'{{{TT}}}Uri').text = self.uri
        else:
            raise AssertionError('mutating or undocumented SOAP operation')
        return 200, {}, ET.tostring(envelope)


class RtspFixture:
    """A fragmented duplex stream, exercising the real parser and requests."""
    def __init__(self, *, reject=None, mismatch=None, frames=None, timeout_at=None, auth=False,
                 challenges=None, password=SECRET, rotate_nonce=False):
        self.reject, self.mismatch, self.timeout_at, self.auth = reject, mismatch, timeout_at, auth
        # `challenges`: WWW-Authenticate values ({nonce} filled in); Digest is verified.
        self.challenges, self.password, self.rotate_nonce = challenges, password, rotate_nonce
        self.nonce, self.nc = 'fixture-nonce', []
        self.frames = frames if frames is not None else interleaved(0, packet())
        self.pending = bytearray()
        self.requests = []
        self.closed = False
        self.played = False

    def settimeout(self, value):
        assert 0 < value <= 10

    def sendall(self, data):
        text = data.decode()
        lines = text.split('\r\n')
        method, uri, protocol = lines[0].split(' ')
        assert protocol == 'RTSP/1.0'
        fields = dict(line.split(': ', 1) for line in lines[1:] if ': ' in line)
        self.requests.append((method, uri, fields))
        if method == self.timeout_at:
            return
        status = 200
        reply = {'CSeq': fields['CSeq']}
        body = b''
        extra = []
        if self.challenges is not None and not self.digest_ok(method, uri, fields.get('Authorization')):
            status = 401
            if self.rotate_nonce:
                self.nonce = f'fixture-nonce-{fields["CSeq"]}'
            extra = [c.format(nonce=self.nonce) for c in self.challenges]
        elif self.auth and 'Authorization' not in fields:
            status = 401
            reply['WWW-Authenticate'] = 'Digest realm="camera", nonce="testnonce", qop="auth", algorithm=MD5'
        elif method == self.reject:
            status = 401
        elif method == 'DESCRIBE':
            reply['Content-Type'] = 'application/sdp'
            reply['Content-Base'] = uri.rsplit('?', 1)[0] + '/'
            body = (b'v=0\r\na=control:*\r\nm=audio 0 RTP/AVP 0\r\na=control:audio\r\n'
                    b'm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=framerate:30\r\na=control:track1\r\n')
        elif method == 'SETUP':
            assert uri.endswith('/track1')
            assert fields['Transport'] == 'RTP/AVP/TCP;unicast;interleaved=0-1'
            reply['Session'] = 'synthetic-session;timeout=60'
            reply['Transport'] = 'RTP/AVP/TCP;unicast;interleaved=0-1;ssrc=0000007b'
        elif method in {'PLAY', 'TEARDOWN'}:
            assert fields['Session'] == 'synthetic-session'
            reply['Session'] = 'synthetic-session'
        if self.mismatch == 'cseq':
            reply['CSeq'] = '9999'
        if self.mismatch == 'session' and method == 'PLAY':
            reply['Session'] = 'different-session'
        if self.mismatch == 'transport' and method == 'SETUP':
            reply['Transport'] = 'RTP/AVP;unicast;client_port=1000-1001'
        reply['Content-Length'] = str(len(body))
        response = (f'RTSP/1.0 {status} Fixture\r\n' + ''.join(f'{k}: {v}\r\n' for k, v in reply.items())
                    + ''.join(f'WWW-Authenticate: {c}\r\n' for c in extra) + '\r\n')
        self.pending.extend(response.encode() + body)
        if method == 'PLAY' and status == 200:
            self.pending.extend(self.frames)
            self.played = True

    def digest_ok(self, method, uri, header):
        if not header or not header.startswith('Digest '):
            return False
        f = parse_keqv_list(parse_http_list(header[7:]))
        self.nc.append(f.get('nc'))
        md5 = lambda text: hashlib.md5(text.encode()).hexdigest()
        ha1, ha2 = md5(f'{USER}:fixture-realm:{self.password}'), md5(f'{method}:{uri}')
        expected = md5(f"{ha1}:{self.nonce}:{f.get('nc')}:{f.get('cnonce')}:auth:{ha2}")
        return f['uri'] == uri and f['nonce'] == self.nonce and f['response'] == expected

    def recv(self, count):
        if not self.pending:
            raise TimeoutError(SECRET)
        result = bytes(self.pending[:min(count, 7)])
        del self.pending[:len(result)]
        return result

    def close(self):
        self.closed = True


def run_fixture(soap=None, rtsp=None, config=None):
    soap = soap or SoapFixture()
    rtsp = rtsp or RtspFixture()
    rows = stream_probe.collect(config or CONFIG, CREDENTIALS, Budget(5, .5), 1,
        discovery_class=lambda *args: OnvifDiscovery(*args, post=soap),
        rtsp_class=lambda *args: RtspProbe(*args, connect=lambda *a, **kw: rtsp))
    return rows, soap, rtsp


class StreamProbeTests(unittest.TestCase):
    def test_full_discovery_negotiation_media_and_cleanup(self):
        rows, soap, rtsp = run_fixture()
        self.assertEqual(soap.calls, ['GetDeviceInformation', 'GetCapabilities', 'GetProfiles', 'GetStreamUri'])
        self.assertEqual([r['result'] for r in rows], ['SUCCEEDED'] * 3)
        self.assertEqual([r[0] for r in rtsp.requests], ['DESCRIBE', 'SETUP', 'PLAY', 'TEARDOWN'])
        self.assertTrue(rtsp.closed)
        self.assertEqual(rows[2]['media']['measurement'], 'RTP_VIDEO_PACKETS')
        self.assertEqual(rows[2]['media']['count'], 1)
        self.assertNotIn('media', rows[0])
        self.assertNotIn('media', rows[1])
        self.assertNotIn('negotiation', rows[0])
        for row in rows:
            self.assertEqual(row['source'], 'ADAPTER')
            self.assertEqual(row['deviceId'], CONFIG['deviceId'])
            self.assertEqual(row['probeId'], CONFIG['probeId'])
            observed, expires = [datetime.fromisoformat(row[k]) for k in ['observedAt', 'expiresAt']]
            self.assertEqual((expires - observed).total_seconds(), 60)
            self.assertLess(len(json.dumps(row).encode()), 4096)
        self.assertEqual(len({r['sourceEventKey'] for r in rows}), 3)
        media = rows[2]['media']
        age = (datetime.fromisoformat(rows[2]['observedAt']) - datetime.fromisoformat(media['lastReceivedAt'])).total_seconds() * 1000
        self.assertTrue(0 <= age <= media['windowMs'])
        serialized = json.dumps(rows)
        for value in [SECRET, USER, SERIAL, PROFILE, 'synthetic-session', 'rtsp://', 'Authorization', 'framerate']:
            self.assertNotIn(value, serialized)

    def test_onvif_auth_rejected_no_stream_claim(self):
        rows, soap, rtsp = run_fixture(SoapFixture(fail='GetDeviceInformation'))
        self.assertEqual(rows[0]['reason'], 'AUTHENTICATION_FAILED')
        self.assertEqual(rows[1]['result'], 'NOT_OBSERVED')
        self.assertEqual(rows[2]['result'], 'NOT_OBSERVED')
        self.assertEqual(rtsp.requests, [])

    def test_onvif_digest_challenge(self):
        soap = SoapFixture(auth=True)
        rows, _, _ = run_fixture(soap)
        self.assertEqual([row['result'] for row in rows], ['SUCCEEDED'] * 3)
        self.assertEqual(len(soap.authenticated), 4)

    def test_camera_identity_mismatch_and_multisource_fail_closed(self):
        for soap, config in [(SoapFixture(), {**CONFIG, 'expectedSerialSha256': '0' * 64}),
                             (SoapFixture(multi_source=True), CONFIG),
                             (SoapFixture(), {**CONFIG, 'profileSha256': '0' * 64})]:
            rows, soap, rtsp = run_fixture(soap, config=config)
            self.assertNotEqual(rows[0]['result'], 'SUCCEEDED')
            self.assertNotIn('GetStreamUri', soap.calls)
            self.assertEqual(rtsp.requests, [])

    def test_configured_uri_cannot_replace_get_stream_uri(self):
        rows, _, rtsp = run_fixture(SoapFixture(fail='GetStreamUri'))
        self.assertEqual(rows[0]['result'], 'FAILED')
        self.assertEqual(rtsp.requests, [])

    def test_no_cross_host_credential_forwarding(self):
        for fixture in [SoapFixture(uri='rtsp://192.0.2.2/video'), SoapFixture(address='http://192.0.2.2/media')]:
            rows, _, rtsp = run_fixture(fixture)
            self.assertEqual(rows[0]['result'], 'FAILED')
            self.assertEqual(rtsp.requests, [])

    def test_authentication_rejected_at_each_rtsp_stage(self):
        for stage in ['DESCRIBE', 'SETUP', 'PLAY']:
            with self.subTest(stage=stage):
                rows, _, rtsp = run_fixture(rtsp=RtspFixture(reject=stage))
                self.assertEqual(rows[0]['result'], 'SUCCEEDED')
                self.assertEqual(rows[1]['reason'], 'AUTHENTICATION_FAILED')
                self.assertEqual(rows[2]['result'], 'NOT_OBSERVED')
                self.assertNotIn('negotiation', rows[1])
                self.assertTrue(rtsp.closed)

    def test_timeout_at_each_rtsp_stage(self):
        for stage in ['DESCRIBE', 'SETUP', 'PLAY']:
            rows, _, rtsp = run_fixture(rtsp=RtspFixture(timeout_at=stage))
            self.assertEqual(rows[1]['reason'], 'TIMEOUT')
            self.assertTrue(rtsp.closed)

    def test_wrong_cseq_session_and_transport_never_prove_e5(self):
        for mismatch in ['cseq', 'session', 'transport']:
            rows, _, rtsp = run_fixture(rtsp=RtspFixture(mismatch=mismatch))
            self.assertNotEqual(rows[1]['result'], 'SUCCEEDED')
            self.assertEqual(rows[2]['result'], 'NOT_OBSERVED')
            self.assertTrue(rtsp.closed)

    def test_no_media_despite_fps_in_sdp(self):
        rows, _, rtsp = run_fixture(rtsp=RtspFixture(frames=b''))
        self.assertEqual(rows[1]['result'], 'SUCCEEDED')
        self.assertEqual(rows[2]['result'], 'FAILED')
        self.assertEqual(rows[2]['reason'], 'TIMEOUT')
        self.assertNotIn('media', rows[2])
        self.assertNotIn('negotiation', rows[2])
        self.assertTrue(rtsp.closed)

    def test_rtcp_audio_wrong_ssrc_and_arbitrary_bytes_do_not_count(self):
        invalid = [interleaved(1, packet()), interleaved(0, packet(pt=0)),
                   interleaved(0, packet(pt=200)), interleaved(0, packet(ssrc=999)),
                   interleaved(0, b'not video'), interleaved(2, packet())]
        rows, _, _ = run_fixture(rtsp=RtspFixture(frames=b''.join(invalid)))
        self.assertEqual(rows[2]['reason'], 'TIMEOUT')
        rows, _, _ = run_fixture(rtsp=RtspFixture(frames=b''.join(invalid) + interleaved(0, packet())))
        self.assertEqual(rows[2]['media']['count'], 1)

    def test_rtp_header_extension_and_padding_validation(self):
        for data in [packet(payload=b''), packet(flags=0x90), packet(flags=0xa0, payload=b'\x00'),
                     packet(flags=0xa0, payload=b'\xff'), packet(flags=0x8f), packet(flags=0x40)]:
            self.assertIsNone(rtp_video(data, {96}))
        self.assertEqual(rtp_video(packet(flags=0xa0, payload=b'\x65\x00\x02'), {96}), 123)
        self.assertEqual(rtp_video(packet(flags=0x90, payload=b'\x00\x00\x00\x01ABCD\x65'), {96}), 123)

    def test_digest_challenge_supported(self):
        rows, _, rtsp = run_fixture(rtsp=RtspFixture(auth=True))
        self.assertEqual(rows[2]['result'], 'SUCCEEDED')
        authenticated = [r for r in rtsp.requests if 'Authorization' in r[2]]
        self.assertEqual(len(authenticated), 4)
        # Digest's required `uri` parameter is protocol state, retained only
        # in the connection; it must never enter API evidence or terminal logs.
        self.assertTrue(all('Authorization' in r[2] for r in authenticated))
        self.assertNotIn(SECRET, json.dumps([r['endpoint'] for r in rows if 'endpoint' in r]))

    def test_digest_matches_rfc_example(self):
        # RFC 2617 example, synthetic well-known credentials.
        with patch('stream_probe_common.secrets.token_hex', return_value='0a4f113b'):
            value = authorization('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
                                  'GET', '/dir/index.html', Credentials('Mufasa', 'Circle Of Life'))
        self.assertIn('response="6629fae49393a05397450978507c4ef1"', value)
        with self.assertRaises(ProbeError):
            authorization('Digest realm="r", nonce="n", qop="auth-int"', 'GET', '/', CREDENTIALS)
        with self.assertRaises(ProbeError):
            authorization('Basic realm="camera"', 'GET', '/', CREDENTIALS)

    def test_discovered_userinfo_is_not_used(self):
        rows, _, rtsp = run_fixture(SoapFixture(uri=URI.replace('rtsp://', 'rtsp://embedded:credential@')))
        self.assertEqual(rows[0]['result'], 'SUCCEEDED')
        for _, uri, _ in rtsp.requests:
            self.assertNotIn('embedded', uri)
            self.assertNotIn('credential@', uri)

    def test_delivery_retries_same_event_without_mutating_evidence(self):
        rows, _, _ = run_fixture()
        original = copy.deepcopy(rows)
        for failure in [(500, {}, SECRET.encode()), TimeoutError(SECRET), ConnectionRefusedError(SECRET)]:
            post = Mock(side_effect=[failure, (201, {}, b'{"accepted":1}'),
                                     (201, {}, b'{"accepted":0}'), (201, {}, b'{"accepted":1}')])
            sleep = Mock()
            count = stream_probe.deliver(rows, 'http://127.0.0.1/api/v1', CONFIG['observerId'], SECRET,
                                         Budget(5, .5), post=post, sleep=sleep)
            self.assertEqual(count, 3)
            self.assertEqual(post.call_args_list[0].args[1], post.call_args_list[1].args[1])
            self.assertEqual(post.call_args_list[0].args[0], 'http://127.0.0.1/api/v1/telemetry/stream-evidence')
            self.assertEqual(post.call_args_list[0].args[2]['x-device-id'], CONFIG['observerId'])
            self.assertEqual(rows, original)
            sleep.assert_called_once()

    def test_ingestion_rejection_is_not_retried_or_reclassified(self):
        rows, _, _ = run_fixture()
        post = Mock(return_value=(403, {}, SECRET.encode()))
        self.assertEqual(stream_probe.deliver(rows, 'http://127.0.0.1/api/v1', CONFIG['observerId'], SECRET,
                                              Budget(5, .5), post=post), 0)
        self.assertEqual(post.call_count, 1)
        self.assertEqual(rows[2]['result'], 'SUCCEEDED')

    def test_budget_and_urls_fail_with_constant_errors(self):
        with self.assertRaisesRegex(ProbeError, '^TIMEOUT$'):
            Budget(-1, 1).remaining()
        for value in ['http://user:secret@127.0.0.1/', 'http://secret.invalid/', 'http://127.0.0.1/\nsecret',
                      'http://127.0.0.1:0/', 'rtsp://127.0.0.1/']:
            with self.assertRaisesRegex(ProbeError, '^PROTOCOL_ERROR$'):
                checked_url(value, {'http', 'https'})

    def test_config_binds_exactly_one_existing_mapped_camera(self):
        config = {k: CONFIG[k] for k in ['probeId', 'channelId', 'onvifDeviceService', 'expectedSerialSha256']}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            path.write_text(json.dumps(config))
            loaded = stream_probe.load_config(path, MAPPING)
            self.assertEqual(loaded['deviceId'], CONFIG['deviceId'])
            self.assertEqual(loaded['observerId'], CONFIG['observerId'])
            config['streamUri'] = URI
            path.write_text(json.dumps(config))
            with self.assertRaises(ProbeError):
                stream_probe.load_config(path, MAPPING)

    def test_cli_logs_only_enums_and_counts_and_never_sends_without_flag(self):
        rows, _, _ = run_fixture()
        out = io.StringIO()
        with patch.object(stream_probe, 'load_config', return_value=CONFIG), \
             patch.object(stream_probe, '_load_speco_map', return_value=MAPPING), \
             patch.object(stream_probe, '_load_simple_env', return_value={'PSOP_HIKVISION_USERNAME': USER, 'PSOP_HIKVISION_PASSWORD': SECRET}), \
             patch.object(stream_probe, 'collect', return_value=rows), \
             patch.object(stream_probe, 'deliver') as deliver, contextlib.redirect_stdout(out):
            self.assertEqual(stream_probe.main([]), 0)
        deliver.assert_not_called()
        summary = out.getvalue()
        self.assertIn('NOT_MEASURED', summary)
        for value in [SECRET, USER, SERIAL, PROFILE, '127.0.0.1', 'rtsp://']:
            self.assertNotIn(value, summary)

    def test_unknown_exceptions_are_sanitized(self):
        def fail(*args):
            raise RuntimeError(f'Authorization: {SECRET} {URI}')
        rows = stream_probe.collect(CONFIG, CREDENTIALS, Budget(5, .5), 1, discovery_class=fail)
        self.assertEqual(rows[0]['reason'], 'PROTOCOL_ERROR')
        self.assertNotIn(SECRET, json.dumps(rows))

    def test_nvr_mediated_check_never_claims_e4_or_decoded_frames(self):
        import nvr_rtsp_check
        run = lambda rtsp: nvr_rtsp_check.check(URI, CREDENTIALS, Budget(5, .5), 1,
            rtsp_class=lambda *args: RtspProbe(*args, connect=lambda *a, **kw: rtsp))[0]
        ok = run(RtspFixture())
        self.assertEqual((ok['e4Discovery'], ok['decodedFrames'], ok['delivery']),
                         ('NOT_PERFORMED', 'NOT_MEASURED', 'NOT_SENT'))
        self.assertEqual((ok['negotiation'], ok['media']['measurement'], ok['media']['count']),
                         ('SUCCEEDED', 'RTP_VIDEO_PACKETS', 1))
        denied = run(RtspFixture(reject='SETUP'))
        self.assertEqual((denied['negotiation'], denied['media']), ('FAILED:AUTHENTICATION_FAILED', 'NOT_ATTEMPTED'))
        silent = run(RtspFixture(frames=b''))
        self.assertEqual((silent['negotiation'], silent['media']), ('SUCCEEDED', 'FAILED:TIMEOUT'))
        for value in [SECRET, USER, '127.0.0.1', 'rtsp://']:
            self.assertNotIn(value, json.dumps([ok, denied, silent]))


    def test_digest_verified_per_stage_with_multiple_challenges(self):
        digest = 'Digest realm="fixture-realm", nonce="{nonce}", qop="auth"'
        for challenges in [[digest], ['Basic realm="fixture-realm"', digest],
                           ['Digest realm="fixture-realm", nonce="x", algorithm=SHA-512', digest]]:
            for rotate in [False, True]:
                with self.subTest(challenges=challenges, rotate=rotate):
                    rtsp = RtspFixture(challenges=challenges, rotate_nonce=rotate)
                    rows, _, _ = run_fixture(rtsp=rtsp)
                    self.assertEqual(rows[2]['result'], 'SUCCEEDED')
                    sent = [r[2]['Authorization'] for r in rtsp.requests if 'Authorization' in r[2]]
                    self.assertTrue(sent and all(v.startswith('Digest ') for v in sent))
                    # nc counts uses of one nonce; a fresh nonce restarts at 1.
                    nc = [n for n in rtsp.nc if n]
                    self.assertEqual(nc, ['00000001'] * 4 if rotate else [f'{i:08x}' for i in range(1, 5)])

    def test_nvr_check_reports_sanitized_rtsp_auth_diagnostic(self):
        import nvr_rtsp_check
        def run(rtsp):
            return nvr_rtsp_check.check(URI, CREDENTIALS, Budget(5, .5), 1,
                rtsp_class=lambda *args: RtspProbe(*args, connect=lambda *a, **kw: rtsp))[0]
        digest = 'Digest realm="fixture-realm", nonce="{nonce}", qop="auth", stale=FALSE'
        cases = [
            (RtspFixture(challenges=[digest], password='wrong'), 'FAILED:AUTHENTICATION_FAILED',
             {'stage': 'DESCRIBE', 'status': 401, 'authScheme': 'DIGEST', 'detail': 'CREDENTIALS_REJECTED'}),
            (RtspFixture(challenges=['Basic realm="fixture-realm"']), 'UNSUPPORTED:CAPABILITY_UNAVAILABLE',
             {'stage': 'DESCRIBE', 'status': 401, 'authScheme': 'BASIC', 'detail': 'NO_DIGEST_CHALLENGE'}),
            (RtspFixture(reject='SETUP'), 'FAILED:AUTHENTICATION_FAILED',
             {'stage': 'SETUP', 'status': 401, 'authScheme': 'NONE', 'detail': 'NO_CHALLENGE'}),
        ]
        for rtsp, negotiation, diagnostic in cases:
            with self.subTest(diagnostic=diagnostic):
                summary = run(rtsp)
                self.assertEqual((summary['negotiation'], summary['diagnostic']), (negotiation, diagnostic))
                # Basic is never a fallback.
                self.assertFalse(any(r[2].get('Authorization', '').startswith('Basic') for r in rtsp.requests))
                self.assertLessEqual(sum(r[0] == diagnostic['stage'] for r in rtsp.requests), 2)
                text = json.dumps(summary)
                for value in [SECRET, USER, 'wrong', 'fixture-realm', 'fixture-nonce', 'synthetic-session',
                              '127.0.0.1', 'rtsp://', 'Authorization', 'response=']:
                    self.assertNotIn(value, text)
        expired = RtspFixture(challenges=[digest.replace('FALSE', 'TRUE')], password='wrong')
        self.assertEqual(run(expired)['diagnostic']['detail'], 'STALE_NONCE')

    def test_stale_nonce_is_renewed_once_without_new_credentials(self):
        import nvr_rtsp_check
        stale = 'Digest realm="fixture-realm", nonce="{nonce}", qop="auth", stale=TRUE'

        class ExpiresNonce(RtspFixture):
            """Right password, but the server expires the nonce `times` times (RFC 7616 3.3)."""
            def __init__(self, times):
                super().__init__(challenges=[stale], rotate_nonce=True)
                self.times = times
            def digest_ok(self, method, uri, header):
                if header and self.times:
                    self.times -= 1
                    return False
                return super().digest_ok(method, uri, header)

        def run(rtsp):
            return nvr_rtsp_check.check(URI, CREDENTIALS, Budget(5, .5), 1,
                rtsp_class=lambda *args: RtspProbe(*args, connect=lambda *a, **kw: rtsp))[0]
        once = ExpiresNonce(1)
        self.assertEqual(run(once)['negotiation'], 'SUCCEEDED')
        self.assertEqual(sum(r[0] == 'DESCRIBE' for r in once.requests), 3)
        # Bounded: a second stale answer for the same request is a failure, not a loop.
        again = ExpiresNonce(2)
        summary = run(again)
        self.assertEqual((summary['negotiation'], summary['diagnostic']['detail']),
                         ('FAILED:AUTHENTICATION_FAILED', 'STALE_NONCE'))
        self.assertEqual(sum(r[0] == 'DESCRIBE' for r in again.requests), 3)



NVR_MAPPING = {'recorder': {'deviceId': CONFIG['observerId']},
               'channels': {'{ch-1}': {'deviceId': '44444444-4444-4444-8444-444444444444', 'channelNumber': 1},
                            '{ch-2}': {'deviceId': CONFIG['deviceId'], 'channelNumber': 2}}}


class NvrMediatedEvidenceTests(unittest.TestCase):
    """E5/E6 rows from the NVR check, shaped for the ingestion contract."""

    def binding(self):
        import nvr_rtsp_check
        return nvr_rtsp_check.bind_channel(NVR_MAPPING, '{ch-2}', 2, CONFIG['probeId'], CONFIG['observerId'])

    def run_check(self, rtsp):
        import nvr_rtsp_check
        return nvr_rtsp_check.check(URI, CREDENTIALS, Budget(5, .5), 1, binding=self.binding(),
            rtsp_class=lambda *args: RtspProbe(*args, connect=lambda *a, **kw: rtsp))

    def assert_contract(self, rows):
        self.assertEqual([r['level'] for r in rows], ['E5_RTSP_SESSION_NEGOTIATED', 'E6_FRAMES_RECEIVED'])
        self.assertEqual(len({r['attemptId'] for r in rows}), 1)
        self.assertEqual(len({r['sourceEventKey'] for r in rows}), 2)
        for row in rows:
            # Provenance: recorder adapter via NVR, manual URI, explicit channel.
            self.assertEqual((row['deviceId'], row['source']), (CONFIG['deviceId'], 'ADAPTER'))
            self.assertEqual({k: row['endpoint'][k] for k in ['access', 'discoveryMethod', 'channelNumber']},
                             {'access': 'NVR_MEDIATED', 'discoveryMethod': 'MANUAL_OPERATOR_INPUT', 'channelNumber': 2})
            self.assertNotIn('profileSha256', row['endpoint'])
            observed = datetime.fromisoformat(row['observedAt'].replace('Z', '+00:00'))
            expires = datetime.fromisoformat(row['expiresAt'].replace('Z', '+00:00'))
            self.assertEqual((expires - observed).total_seconds(), 60)
            self.assertLessEqual(len(json.dumps(row)), 4096)
        text = json.dumps(rows)
        for value in [SECRET, USER, 'rtsp://', 'token', 'synthetic-session', 'Authorization', 'E4_']:
            self.assertNotIn(value, text)

    def test_success_records_negotiation_and_rtp_packets_not_frames(self):
        summary, rows = self.run_check(RtspFixture())
        self.assert_contract(rows)
        self.assertEqual([(r['result'], r['reason']) for r in rows], [('SUCCEEDED', 'NONE')] * 2)
        self.assertEqual(rows[0]['negotiation']['playStatus'], 200)
        self.assertEqual(rows[1]['media']['measurement'], 'RTP_VIDEO_PACKETS')
        self.assertEqual(rows[1]['media']['count'], 1)
        self.assertEqual((summary['decodedFrames'], summary['e4Discovery'], summary['channelNumber']),
                         ('NOT_MEASURED', 'NOT_PERFORMED', 2))

    def test_authentication_failure_records_failed_e5_and_unattempted_e6(self):
        _, rows = self.run_check(RtspFixture(reject='DESCRIBE'))
        self.assert_contract(rows)
        self.assertEqual([(r['result'], r['reason']) for r in rows],
                         [('FAILED', 'AUTHENTICATION_FAILED'), ('NOT_OBSERVED', 'NOT_ATTEMPTED')])
        self.assertFalse(any('negotiation' in r or 'media' in r for r in rows))

    def test_no_media_keeps_negotiation_and_fails_e6(self):
        _, rows = self.run_check(RtspFixture(frames=b''))
        self.assert_contract(rows)
        self.assertEqual([(r['result'], r['reason']) for r in rows],
                         [('SUCCEEDED', 'NONE'), ('FAILED', 'TIMEOUT')])
        self.assertNotIn('media', rows[1])
        self.assertNotIn('negotiation', rows[1])

    def test_without_binding_nothing_is_prepared_for_delivery(self):
        import nvr_rtsp_check
        summary, rows = nvr_rtsp_check.check(URI, CREDENTIALS, Budget(5, .5), 1,
            rtsp_class=lambda *args: RtspProbe(*args, connect=lambda *a, **kw: RtspFixture()))
        self.assertEqual((rows, summary['delivery']), ([], 'NOT_SENT'))

    def test_channel_binding_is_explicit_and_cross_checked(self):
        import nvr_rtsp_check
        bind = nvr_rtsp_check.bind_channel
        # deviceId comes from the mapping entry, never from the channel number.
        self.assertEqual(self.binding()['deviceId'], CONFIG['deviceId'])
        for args in [('{ch-2}', 1, CONFIG['probeId'], None),          # number disagrees with mapping
                     ('{ch-1}', 2, CONFIG['probeId'], None),
                     ('2', 2, CONFIG['probeId'], None),               # number is not a channel key
                     ('{ch-2}', '2', CONFIG['probeId'], None),
                     ('{ch-2}', 2, 'not-a-uuid', None),
                     ('{ch-2}', 2, CONFIG['probeId'], '55555555-5555-4555-8555-555555555555')]:  # other NVR
            with self.subTest(args=args), self.assertRaises(Exception):
                bind(NVR_MAPPING, *args)
        with self.assertRaises(Exception):
            bind({'recorder': {'deviceId': CONFIG['deviceId']}, 'channels': NVR_MAPPING['channels']},
                 '{ch-2}', 2, CONFIG['probeId'])

    def cli(self, argv, rtsp=None, post=None):
        import nvr_rtsp_check
        real_check, real_deliver = nvr_rtsp_check.check, nvr_rtsp_check.deliver
        env = {'PSOP_SPECO_HOST': '127.0.0.1', 'PSOP_API_URL': 'http://127.0.0.1:3000/api/v1',
               'PSOP_SPECO_RECORDER_DEVICE_KEY': 'fixture-only-device-key'}
        out = io.StringIO()
        with patch.object(nvr_rtsp_check, '_load_simple_env', return_value=env), \
             patch.object(nvr_rtsp_check, '_load_speco_map', return_value=NVR_MAPPING), \
             patch.object(nvr_rtsp_check.getpass, 'getpass', side_effect=[USER, SECRET]), \
             patch.object(nvr_rtsp_check, 'check', lambda *a, **kw: real_check(*a, **kw,
                 rtsp_class=lambda *args: RtspProbe(*args, connect=lambda *x, **y: rtsp or RtspFixture()))), \
             patch.object(nvr_rtsp_check, 'deliver', lambda *a: real_deliver(*a, post=post)), \
             patch.dict('os.environ', {}, clear=True), contextlib.redirect_stdout(out):
            try:
                code = nvr_rtsp_check.main(argv)
            except SystemExit as exit:
                code = exit.code
        return code, out.getvalue()

    def test_cli_sends_only_with_explicit_flag_and_binding(self):
        sent = []
        def post(url, body, headers, budget, max_bytes):
            sent.append((url, json.loads(body), headers))
            return 201, {}, b'{"accepted":1}'
        base = ['--uri', URI, '--channel-id', '{ch-2}', '--channel-number', '2', '--probe-id', CONFIG['probeId'],
                '--duration', '1', '--max-duration', '10', '--timeout', '1']
        code, out = self.cli(base, post=post)
        self.assertEqual((code, json.loads(out)['delivery'], sent), (0, 'NOT_SENT', []))
        code, out = self.cli(base + ['--send'], post=post)
        summary = json.loads(out)
        self.assertEqual((code, summary['delivery'], summary['deliveredRows']), (0, 'DELIVERED', 2))
        self.assertEqual({u for u, _, _ in sent}, {'http://127.0.0.1:3000/api/v1/telemetry/stream-evidence'})
        self.assertEqual({h['x-device-id'] for _, _, h in sent}, {CONFIG['observerId']})
        self.assert_contract([b for _, b, _ in sent])
        for value in [SECRET, USER, 'rtsp://', 'fixture-only-device-key']:
            self.assertNotIn(value, out)
        # --send without a complete explicit binding is refused before any I/O.
        code, _ = self.cli(['--uri', URI, '--send'], post=post)
        self.assertEqual((code, len(sent)), (2, 2))
        code, out = self.cli(base[:4] + ['--channel-number', '1'] + base[6:] + ['--send'], post=post)
        self.assertEqual((code, len(sent)), (2, 2))
        self.assertTrue(out.startswith('CHECK_CONFIGURATION_ERROR'))

    def test_speco_chid_must_select_the_bound_channel_before_any_io(self):
        import nvr_rtsp_check
        check = nvr_rtsp_check.uri_channel
        self.assertEqual(check('rtsp://127.0.0.1:554/chID=1&streamType=main&linkType=tcp', 1), 'URI_CHID_MATCHED')
        self.assertEqual(check('rtsp://127.0.0.1:554/?chID=01&streamType=sub', 1), 'URI_CHID_MATCHED')
        # Unknown format: nothing to verify, the operator's association stands.
        self.assertEqual(check(URI, 1), 'OPERATOR_DECLARED')
        for uri in ['rtsp://127.0.0.1:554/chID=2&streamType=main', 'rtsp://127.0.0.1:554/?chID=2',
                    'rtsp://127.0.0.1:554/chID=1&chID=2', 'rtsp://127.0.0.1:554/chid=x', 'rtsp://127.0.0.1:554/chID=',
                    # Repeated, even identical: refused.
                    'rtsp://127.0.0.1:554/chID=1&chID=1', 'rtsp://127.0.0.1:554/chID=1?chID=1']:
            with self.subTest(uri=uri), self.assertRaises(ProbeError):
                check(uri, 1)
        # CLI: chID=2 with the channel-1 binding stops before prompts or sockets.
        prompt, connect = Mock(), Mock()
        env = {'PSOP_SPECO_HOST': '127.0.0.1'}
        out = io.StringIO()
        with patch.object(nvr_rtsp_check, '_load_simple_env', return_value=env), \
             patch.object(nvr_rtsp_check, '_load_speco_map', return_value=NVR_MAPPING), \
             patch.object(nvr_rtsp_check.getpass, 'getpass', prompt), \
             patch.object(socket, 'create_connection', connect), contextlib.redirect_stdout(out):
            code = nvr_rtsp_check.main(['--uri', 'rtsp://127.0.0.1:554/chID=2&streamType=main',
                                        '--channel-id', '{ch-1}', '--channel-number', '1',
                                        '--probe-id', CONFIG['probeId'], '--send'])
        self.assertEqual(code, 2)
        self.assertTrue(out.getvalue().startswith('CHECK_CONFIGURATION_ERROR'))
        prompt.assert_not_called()
        connect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
