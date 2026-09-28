"""Bounded RTSP/1.0 negotiation and interleaved video RTP metadata only.

Implements DESCRIBE -> selected SDP video track -> SETUP -> PLAY -> TEARDOWN.
No decoder, subprocess, media file, packet capture, or recording operation.
"""
from __future__ import annotations

import re
import socket
import ssl
import struct
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin

from stream_probe_common import ProbeError, authorization, checked_url, offered_schemes

MAX_HEADER = 32768
MAX_BODY = 262144
PROOF = {'describeStatus': 200, 'setupStatus': 200, 'playStatus': 200,
         'videoTrackSelected': True, 'sessionEstablished': True, 'transport': 'RTP_AVP_TCP'}


def timestamp(value):
    return value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def select_video(sdp, base, presentation):
    try:
        lines = sdp.decode('utf-8').replace('\r', '').split('\n')
        if not lines or lines[0] != 'v=0':
            raise ValueError()
        session_control, tracks, current = None, [], None
        for line in lines:
            if line.startswith('m='):
                parts = line[2:].split()
                current = {'kind': parts[0], 'protocol': parts[2],
                           'pts': {int(v) for v in parts[3:]}, 'codecs': {}, 'control': None}
                tracks.append(current)
            elif line.startswith('a=control:'):
                if current is None:
                    session_control = line[10:]
                else:
                    current['control'] = line[10:]
            elif current is not None and line.startswith('a=rtpmap:'):
                pt, encoding = line[9:].split(None, 1)
                current['codecs'][int(pt)] = encoding.split('/')[0].upper()
        _, origin = checked_url(presentation, {'rtsp', 'rtsps'})
        base, _ = checked_url(base, {'rtsp', 'rtsps'}, origin=origin)
        aggregate = presentation if session_control in {None, '*'} else urljoin(base, session_control)
        aggregate, _ = checked_url(aggregate, {'rtsp', 'rtsps'}, origin=origin)
        for track in tracks:
            pts = {pt for pt in track['pts'] if 0 <= pt <= 127 and
                   track['codecs'].get(pt) in {'H264', 'H265', 'JPEG', 'MP4V-ES', 'VP8', 'VP9', 'AV1'}}
            if track['kind'] == 'video' and track['protocol'] == 'RTP/AVP' and pts and track['control'] not in {None, '*'}:
                control, _ = checked_url(urljoin(base, track['control']), {'rtsp', 'rtsps'}, origin=origin)
                return control, aggregate, pts
        raise ProbeError('CAPABILITY_UNAVAILABLE', unsupported=True)
    except ProbeError:
        raise
    except (ValueError, IndexError, UnicodeError):
        raise ProbeError() from None


def rtp_video(packet, payload_types, expected_ssrc=None):
    """Validate RTP header/extension/padding and nonempty selected video payload.

    Caller already correlates interleaved channel with this SETUP session.
    Returns SSRC, not payload. RTCP, audio, and arbitrary bytes do not qualify.
    """
    if len(packet) < 12 or packet[0] >> 6 != 2:
        return None
    if packet[1] & 0x7f not in payload_types:
        return None
    offset = 12 + 4 * (packet[0] & 0x0f)
    if offset > len(packet):
        return None
    if packet[0] & 0x10:
        if offset + 4 > len(packet):
            return None
        words = int.from_bytes(packet[offset + 2:offset + 4], 'big')
        offset += 4 + words * 4
    end = len(packet)
    if packet[0] & 0x20:
        padding = packet[-1]
        if not padding or padding > end - offset:
            return None
        end -= padding
    if offset >= end:
        return None
    ssrc = int.from_bytes(packet[8:12], 'big')
    return ssrc if expected_ssrc is None or ssrc == expected_ssrc else None


class RtspProbe:
    def __init__(self, uri, credentials, budget, *, connect=socket.create_connection):
        self.uri, self.origin = checked_url(uri, {'rtsp', 'rtsps'})
        self.credentials, self.budget, self.connect = credentials, budget, connect
        self.sock = None
        self.buffer = bytearray()
        self.cseq = 0
        self.session = None
        self.aggregate = self.uri
        self.video_channel = None
        self.ssrc = None
        self.payload_types = set()
        self.nonce_counts = {}

    def __enter__(self):
        try:
            self.sock = self.connect((self.origin[1], self.origin[2]), timeout=self.budget.remaining())
            if self.origin[0] == 'rtsps':
                self.sock = ssl.create_default_context().wrap_socket(self.sock, server_hostname=self.origin[1])
            return self
        except Exception:
            if self.sock is not None:
                self.sock.close()
            raise

    def _read(self, count, deadline=None):
        while len(self.buffer) < count:
            timeout = self.budget.remaining()
            if deadline is not None:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TimeoutError()
                timeout = min(timeout, left)
            self.sock.settimeout(timeout)
            part = self.sock.recv(min(8192, count - len(self.buffer)))
            if not part:
                raise ProbeError('UNREACHABLE')
            self.buffer.extend(part)
        data = bytes(self.buffer[:count])
        del self.buffer[:count]
        return data

    def _message(self, deadline=None):
        first = self._read(1, deadline)
        if first == b'$':
            header = self._read(3, deadline)
            channel, length = header[0], int.from_bytes(header[1:], 'big')
            return channel, self._read(length, deadline)
        header = bytearray(first)
        while not header.endswith(b'\r\n\r\n'):
            if len(header) >= MAX_HEADER:
                raise ProbeError()
            header.extend(self._read(1, deadline))
        try:
            lines = header.decode('ascii').split('\r\n')
            match = re.fullmatch(r'RTSP/1\.0 ([0-9]{3}) [^\r\n]*', lines[0])
            if not match:
                raise ValueError()
            fields = {}
            for line in lines[1:-2]:
                key, value = line.split(':', 1)
                key, value = key.lower(), value.strip()
                if key == 'www-authenticate':  # RFC 7235: one header per challenge
                    fields.setdefault(key, []).append(value)
                    continue
                if key in fields or not re.fullmatch(r'[a-z0-9-]+', key):
                    raise ValueError()
                fields[key] = value
            length = int(fields.get('content-length', '0'))
            if not 0 <= length <= MAX_BODY:
                raise ValueError()
            return int(match[1]), fields, self._read(length, deadline)
        except (ValueError, UnicodeError):
            raise ProbeError() from None

    def request(self, method, uri, headers=None):
        fields = dict(headers or {})
        for attempt in range(2):
            self.cseq += 1
            fields['CSeq'] = str(self.cseq)
            fields['User-Agent'] = 'PSOP-Manual-Stream-Probe/1'
            if self.session:
                fields['Session'] = self.session
            if any('\r' in str(v) or '\n' in str(v) for v in fields.values()):
                raise ProbeError()
            data = (f'{method} {uri} RTSP/1.0\r\n' + ''.join(f'{k}: {v}\r\n' for k, v in fields.items()) + '\r\n').encode()
            self.sock.settimeout(self.budget.remaining())
            self.sock.sendall(data)
            while True:
                reply = self._message()
                if len(reply) == 3:
                    break
                # Media before confirmed PLAY is deliberately not counted.
            status, response, body = reply
            if response.get('cseq') != str(self.cseq):
                raise ProbeError()
            if status == 401:
                challenges = response.get('www-authenticate', [])
                scheme = offered_schemes(challenges)
                if attempt == 1:
                    stale = any(re.search(r'(^|[\s,])stale\s*=\s*"?true\b', c, re.I) for c in challenges)
                    raise self._failure('AUTHENTICATION_FAILED', method, status, scheme,
                                        'STALE_NONCE' if stale else 'CREDENTIALS_REJECTED')
                if not challenges:
                    raise self._failure('AUTHENTICATION_FAILED', method, status, scheme, 'NO_CHALLENGE')
                try:
                    fields['Authorization'] = authorization(challenges, method, uri,
                                                           self.credentials, self.nonce_counts)
                except ProbeError as error:
                    error.stage, error.status, error.scheme = method, status, scheme
                    raise
                continue
            if status == 403:
                raise self._failure('AUTHENTICATION_FAILED', method, status, None, 'FORBIDDEN')
            if status in {405, 461, 501, 551}:
                raise self._failure('CAPABILITY_UNAVAILABLE', method, status, None, None, unsupported=True)
            if status != 200:
                raise self._failure('PROTOCOL_ERROR', method, status, None, 'UNEXPECTED_STATUS')
            return response, body
        raise ProbeError('AUTHENTICATION_FAILED')

    @staticmethod
    def _failure(reason, stage, status, scheme, detail, *, unsupported=False):
        error = ProbeError(reason, unsupported=unsupported, detail=detail)
        error.stage, error.status, error.scheme = stage, status, scheme
        return error

    def negotiate(self):
        headers, sdp = self.request('DESCRIBE', self.uri, {'Accept': 'application/sdp'})
        if headers.get('content-type', '').split(';')[0].lower() != 'application/sdp':
            raise ProbeError()
        base = headers.get('content-base') or urljoin(self.uri, headers.get('content-location', '')) or self.uri
        control, self.aggregate, self.payload_types = select_video(sdp, base, self.uri)
        headers, _ = self.request('SETUP', control, {'Transport': 'RTP/AVP/TCP;unicast;interleaved=0-1'})
        session = headers.get('session', '').split(';')[0].strip()
        if not re.fullmatch(r'[A-Za-z0-9$_.+\-]{1,256}', session):
            raise ProbeError()
        self.session = session  # retained for cleanup even if transport is invalid
        parts = headers.get('transport', '').split(';')
        if parts[0].upper() != 'RTP/AVP/TCP' or 'unicast' not in [p.strip().lower() for p in parts[1:]]:
            raise ProbeError('CAPABILITY_UNAVAILABLE', unsupported=True)
        params = {}
        for item in parts[1:]:
            if '=' in item:
                key, value = item.strip().split('=', 1)
                if key.lower() in params:
                    raise ProbeError()
                params[key.lower()] = value
        pair = re.fullmatch(r'(\d{1,3})-(\d{1,3})', params.get('interleaved', ''))
        if pair is None or not 0 <= int(pair[1]) < int(pair[2]) <= 255 or int(pair[2]) != int(pair[1]) + 1:
            raise ProbeError()
        self.video_channel = int(pair[1])
        if 'ssrc' in params:
            if not re.fullmatch(r'[a-fA-F0-9]{1,8}', params['ssrc']):
                raise ProbeError()
            self.ssrc = int(params['ssrc'], 16)
        headers, _ = self.request('PLAY', self.aggregate)
        if headers.get('session', '').split(';')[0].strip() != self.session:
            raise ProbeError()
        return dict(PROOF)

    def receive(self, duration):
        started = time.monotonic()
        wall_start = datetime.now(timezone.utc)
        deadline = min(started + duration, self.budget.end)
        count, last = 0, None
        while time.monotonic() < deadline and count < 10000000:
            try:
                frame = self._message(deadline)
            except TimeoutError:
                break
            if len(frame) != 2:
                raise ProbeError()
            channel, packet = frame
            if channel != self.video_channel:
                continue
            ssrc = rtp_video(packet, self.payload_types, self.ssrc)
            if ssrc is not None:
                self.ssrc = ssrc
                count += 1
                last = time.monotonic()
        ended = time.monotonic()
        observed = wall_start + timedelta(seconds=ended - started)
        if not count:
            raise ProbeError('TIMEOUT')
        last_received = wall_start + timedelta(seconds=last - started)
        if last_received > observed:  # keep millisecond-rounded timestamps ordered
            last_received = observed
        return {
            'measurement': 'RTP_VIDEO_PACKETS', 'count': count,
            'windowMs': max(1, min(60000, int((ended - started) * 1000 + 0.999))),
            'lastReceivedAt': timestamp(last_received),
        }, observed

    def __exit__(self, *_):
        try:
            if self.session:
                # Cleanup is best effort and shares the total deadline. Socket
                # close still happens if TEARDOWN is rejected or times out.
                self.request('TEARDOWN', self.aggregate)
        except Exception:
            pass
        finally:
            if self.sock is not None:
                self.sock.close()
            self.buffer.clear()
