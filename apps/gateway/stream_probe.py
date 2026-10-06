#!/usr/bin/env python3
"""Manual, single-camera E4-E6 probe; emits only sanitized metadata.

No watcher integration, runtime changes, media persistence, or automatic service.
"""
from __future__ import annotations

import argparse
import getpass
import json
import math
import os
from pathlib import Path
import re
import signal
import time
import uuid
from datetime import datetime, timedelta, timezone

from onvif_stream import OnvifDiscovery
from rtsp_stream import RtspProbe, timestamp
from speco_n8nrl import DEFAULT_LOCAL_ENV, DEFAULT_LOCAL_MAP, _load_simple_env, _load_speco_map
from stream_probe_common import Budget, Credentials, ProbeError, checked_url, http_post

LEVELS = ['E4_STREAM_URI_OBTAINED', 'E5_RTSP_SESSION_NEGOTIATED', 'E6_FRAMES_RECEIVED']


def failure(error):
    if isinstance(error, ProbeError):
        return error
    if isinstance(error, TimeoutError):
        return ProbeError('TIMEOUT')
    if isinstance(error, OSError):
        return ProbeError('UNREACHABLE')
    return ProbeError()


def observation(config, level, *, result='SUCCEEDED', reason='NONE', observed=None, validity=60, **proof):
    # Validity is fixed at observation time and never extended on resend.
    observed = observed or datetime.now(timezone.utc)
    return {
        'deviceId': config['deviceId'], 'probeId': config['probeId'],
        'sourceEventKey': str(uuid.uuid4()), 'source': 'ADAPTER',
        'level': level, 'result': result, 'reason': reason,
        'observedAt': timestamp(observed), 'expiresAt': timestamp(observed + timedelta(seconds=validity)),
        **proof,
    }


def collect(config, credentials, budget, duration, *, discovery_class=OnvifDiscovery, rtsp_class=RtspProbe):
    rows = []
    endpoint = None
    try:
        discovery = discovery_class(config['onvifDeviceService'], credentials, budget)
        stream = discovery.discover(config['expectedSerialSha256'],
                                    profile_sha256=config.get('profileSha256'),
                                    channel_number=config.get('channelNumber'))
        endpoint = stream.endpoint
        rows.append(observation(config, LEVELS[0], endpoint=endpoint))
        with rtsp_class(stream.uri, credentials, budget) as rtsp:
            negotiation = rtsp.negotiate()
            rows.append(observation(config, LEVELS[1], endpoint=endpoint, negotiation=negotiation))
            media, observed = rtsp.receive(duration)
            rows.append(observation(config, LEVELS[2], endpoint=endpoint,
                                    negotiation=negotiation, media=media, observed=observed))
    except Exception as error:
        # No remote text, SDP, tokens, URLs, passwords, or tracebacks leave here.
        outcome = failure(error)
        if len(rows) < 3:
            rows.append(observation(config, LEVELS[len(rows)], result=outcome.result,
                                    reason=outcome.reason, **({'endpoint': endpoint} if endpoint else {})))
    while len(rows) < 3:
        rows.append(observation(config, LEVELS[len(rows)], result='NOT_OBSERVED', reason='NOT_ATTEMPTED'))
    return rows


def evidence_endpoint(api_url, observer_id, device_key):
    base, _ = checked_url(api_url, {'http', 'https'})
    if '?' in base:
        raise ProbeError()
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json',
               'x-device-id': observer_id, 'x-device-key': device_key}
    return base.rstrip('/') + '/telemetry/stream-evidence', headers


def encode_row(row):
    body = json.dumps(row, separators=(',', ':')).encode()
    if len(body) > 4096:
        raise ProbeError()
    return body


def post_row(body, url, headers, budget, *, post=http_post):
    """One POST of one already-encoded row. ACCEPTED (stored), DUPLICATE (the API
    already had this sourceEventKey; idempotent), REJECTED (4xx: never resend),
    UNAVAILABLE (network/5xx/unreadable: safe to resend the same bytes)."""
    try:
        status, _, response = post(url, body, headers, budget, max_bytes=4096)
        if status in {200, 201}:
            accepted = json.loads(response).get('accepted')
            if type(accepted) is int and accepted in {0, 1}:
                return 'ACCEPTED' if accepted else 'DUPLICATE'
            return 'UNAVAILABLE'
        return 'UNAVAILABLE' if 500 <= status <= 599 else 'REJECTED'
    except Exception:
        # Optional evidence delivery never affects core health/collection.
        return 'UNAVAILABLE'


def deliver(rows, api_url, observer_id, device_key, budget, *, post=http_post, sleep=time.sleep):
    """At most two attempts per event; same UUID/timestamps/body on retries."""
    url, headers = evidence_endpoint(api_url, observer_id, device_key)
    delivered = 0
    for row in rows:
        body = encode_row(row)
        for attempt in range(2):
            outcome = post_row(body, url, headers, budget, post=post)
            if outcome in {'ACCEPTED', 'DUPLICATE'}:
                delivered += 1
                break
            if outcome == 'REJECTED' or attempt == 1:
                return delivered
            try:
                delay = min(1.0, budget.remaining())
                sleep(delay)
                budget.remaining()
            except ProbeError:
                return delivered
    return delivered


def load_config(path, mapping):
    raw = json.loads(Path(path).read_text())
    required = {'probeId', 'channelId', 'onvifDeviceService', 'expectedSerialSha256'}
    if not isinstance(raw, dict) or not required <= raw.keys() or raw.keys() - required - {'profileSha256'}:
        raise ProbeError()
    config = dict(raw)
    for key in ['expectedSerialSha256', 'profileSha256']:
        if key in config and (not isinstance(config[key], str) or not re.fullmatch(r'[a-f0-9]{64}', config[key])):
            raise ProbeError()
    checked_url(config['onvifDeviceService'], {'http', 'https'})
    channel = mapping['channels'][config['channelId']]
    config['deviceId'] = channel['deviceId']
    config['observerId'] = mapping['recorder']['deviceId']
    for key in ['probeId', 'deviceId', 'observerId']:
        config[key] = str(uuid.UUID(config[key]))
    if 'channelNumber' in channel:
        value = channel['channelNumber']
        if type(value) is not int or not 1 <= value <= 65535:
            raise ProbeError()
        config['channelNumber'] = value
    return config


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's default includes invalid supplied values in diagnostics.
        self.exit(2, 'Invalid probe arguments; use --help.\n')


def main(argv=None):
    parser = SafeParser(description='Manual ONVIF/RTSP metadata probe for ONE mapped Hikvision camera; no media files.')
    parser.add_argument('--config', default=str(Path(__file__).with_name('stream-probe.local.json')))
    parser.add_argument('--timeout', type=float, default=3, help='Per-I/O timeout, 0.5–10 seconds')
    parser.add_argument('--duration', type=float, default=5, help='Media window, 1–30 seconds')
    parser.add_argument('--max-duration', type=float, default=60, help='Total network budget including delivery/cleanup, 5–120 seconds')
    parser.add_argument('--send', action='store_true', help='Send sanitized observations to the existing ingestion endpoint')
    args = parser.parse_args(argv)
    if not all(math.isfinite(v) for v in [args.timeout, args.duration, args.max_duration]) or not (
            .5 <= args.timeout <= 10 and 1 <= args.duration <= 30 and 5 <= args.max_duration <= 120
            and args.duration < args.max_duration):
        parser.error('bounds')
    try:
        config = load_config(args.config, _load_speco_map(DEFAULT_LOCAL_MAP))
        local = _load_simple_env(DEFAULT_LOCAL_ENV)
        api_url = os.environ.get('PSOP_API_URL') or local.get('PSOP_API_URL')
        device_key = os.environ.get('PSOP_SPECO_RECORDER_DEVICE_KEY') or local.get('PSOP_SPECO_RECORDER_DEVICE_KEY')
        configured_id = local.get('PSOP_SPECO_RECORDER_DEVICE_ID')
        if configured_id and configured_id != config['observerId']:
            raise ProbeError()
        if args.send:
            if not device_key or not api_url:
                raise ProbeError()
            checked_url(api_url, {'http', 'https'})
        username = os.environ.get('PSOP_HIKVISION_USERNAME') or local.get('PSOP_HIKVISION_USERNAME') or getpass.getpass('ONVIF camera username (hidden): ')
        password = os.environ.get('PSOP_HIKVISION_PASSWORD') or local.get('PSOP_HIKVISION_PASSWORD') or getpass.getpass('ONVIF/RTSP camera password: ')
        if not username or not password:
            raise ProbeError()
        credentials = Credentials(username, password)
    except KeyboardInterrupt:
        return 130
    except Exception:
        print('PROBE_CONFIGURATION_ERROR: check local single-camera mapping and credentials.')
        return 2

    # POSIX CLI hard deadline also bounds slow HTTP headers/trickle responses.
    # No external executable sees credentials or authenticated URIs in argv.
    def expired(*_):
        raise ProbeError('TIMEOUT')
    def interrupted(*_):
        raise KeyboardInterrupt()
    previous_alarm = signal.signal(signal.SIGALRM, expired)
    previous_term = signal.signal(signal.SIGTERM, interrupted)
    signal.setitimer(signal.ITIMER_REAL, args.max_duration)
    budget = Budget(args.max_duration, args.timeout)
    try:
        rows = collect(config, credentials, budget, args.duration)
        count = deliver(rows, api_url, config['observerId'], device_key, budget) if args.send else 0
        # Only enums/counts. Even sanitized endpoint fingerprints need not be
        # exposed in terminal logs; the authenticated ledger receives them.
        summary = {'evidence': [
            {k: row[k] for k in ['level', 'result', 'reason']} |
            ({'media': row['media']} if 'media' in row else {}) for row in rows],
            'decodedFrames': 'NOT_MEASURED',
            'delivery': 'NOT_REQUESTED' if not args.send else 'DELIVERED' if count == 3 else 'DELIVERY_ERROR'}
        print(json.dumps(summary, sort_keys=True))
        return 0 if all(row['result'] == 'SUCCEEDED' for row in rows) and (not args.send or count == 3) else 1
    except KeyboardInterrupt:
        print('PROBE_INTERRUPTED')
        return 130
    except Exception:
        print('PROBE_INCOMPLETE')
        return 1
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_alarm)
        signal.signal(signal.SIGTERM, previous_term)


if __name__ == '__main__':
    raise SystemExit(main())
