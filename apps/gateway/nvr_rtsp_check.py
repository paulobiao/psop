#!/usr/bin/env python3
"""Manual NVR-mediated RTSP check: DESCRIBE -> SETUP -> PLAY -> bounded RTP count.

The URI is operator-supplied from the recorder UI, not ONVIF-discovered, so this
never produces E4. The recorder served the stream, so evidence is attested by
the recorder adapter for one explicitly mapped channel, never as a direct
camera observation. Nothing is sent unless --send is given. No media is stored
or decoded; only enums, identifiers and RTP video packet counts are printed.
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import signal
import uuid
from urllib.parse import urlsplit

from rtsp_stream import RtspProbe
from speco_n8nrl import DEFAULT_LOCAL_ENV, DEFAULT_LOCAL_MAP, _load_simple_env, _load_speco_map
from stream_probe import SafeParser, deliver, failure, observation
from stream_probe_common import Budget, Credentials, ProbeError, checked_url

E5, E6 = 'E5_RTSP_SESSION_NEGOTIATED', 'E6_FRAMES_RECEIVED'


def bind_channel(mapping, channel_id, channel_number, probe_id, configured_observer=None):
    """Target comes only from the explicit Speco mapping entry, cross-checked
    against the operator's channel number; a number is never a device identity."""
    channel = mapping['channels'][channel_id]
    if type(channel_number) is not int or channel.get('channelNumber') != channel_number:
        raise ProbeError()
    binding = {'deviceId': str(uuid.UUID(channel['deviceId'])), 'probeId': str(uuid.UUID(probe_id)),
               'observerId': str(uuid.UUID(mapping['recorder']['deviceId'])), 'channelNumber': channel_number}
    if configured_observer and configured_observer != binding['observerId']:
        raise ProbeError()
    if binding['deviceId'] == binding['observerId']:
        raise ProbeError()
    return binding


def nvr_endpoint(uri, channel_number):
    """Path hash only: no userinfo, query, fragment or raw URI leaves the probe."""
    clean, (scheme, host, port) = checked_url(uri, {'rtsp', 'rtsps'})
    return {'protocol': scheme, 'host': host, 'port': port,
            'pathSha256': hashlib.sha256(urlsplit(clean).path.encode()).hexdigest(),
            'channelNumber': channel_number, 'discoveryMethod': 'MANUAL_OPERATOR_INPUT',
            'access': 'NVR_MEDIATED'}


def check(uri, credentials, budget, duration, *, binding=None, rtsp_class=RtspProbe):
    """Returns (terminal summary, E5/E6 ingestion rows); rows only with a binding."""
    summary = {'access': 'NVR_MEDIATED', 'uriSource': 'MANUAL_OPERATOR_INPUT',
               'e4Discovery': 'NOT_PERFORMED', 'negotiation': 'NOT_ATTEMPTED',
               'media': 'NOT_ATTEMPTED', 'decodedFrames': 'NOT_MEASURED', 'delivery': 'NOT_SENT'}
    rows = []
    if binding:
        endpoint = nvr_endpoint(uri, binding['channelNumber'])
        attempt = str(uuid.uuid4())
        summary.update(deviceId=binding['deviceId'], channelNumber=binding['channelNumber'], attemptId=attempt)
    def row(level, **proof):
        if binding:
            rows.append(observation(binding, level, endpoint=endpoint, attemptId=attempt, **proof))
    stage = 'negotiation'
    try:
        with rtsp_class(uri, credentials, budget) as rtsp:
            negotiation = rtsp.negotiate()
            summary['negotiation'] = 'SUCCEEDED'
            row(E5, negotiation=negotiation)
            stage = 'media'
            media, observed = rtsp.receive(duration)
            summary['media'] = {'result': 'SUCCEEDED', 'measurement': media['measurement'],
                                'count': media['count'], 'windowMs': media['windowMs']}
            row(E6, negotiation=negotiation, media=media, observed=observed)
    except Exception as error:
        # Only enumerated codes; no URI, SDP, headers, session or credentials.
        outcome = failure(error)
        summary[stage] = f'{outcome.result}:{outcome.reason}'
        if outcome.diagnostic():
            summary['diagnostic'] = outcome.diagnostic()
        if stage == 'negotiation':
            row(E5, result=outcome.result, reason=outcome.reason)
        elif not isinstance(summary['media'], dict):
            row(E6, result=outcome.result, reason=outcome.reason)
    if binding and len(rows) == 1:
        row(E6, result='NOT_OBSERVED', reason='NOT_ATTEMPTED')
    return summary, rows


def main(argv=None):
    parser = SafeParser(description='Manual NVR-mediated RTSP negotiation/RTP check; no E4, no media files. '
                                    'Sends E5/E6 evidence only with --send.')
    parser.add_argument('--uri', required=True, help='rtsp:// URI copied from the recorder UI, WITHOUT credentials')
    parser.add_argument('--channel-id', help='Exact channel key from speco.local.json (required with --send)')
    parser.add_argument('--channel-number', type=int, help='Recorder channel the URI selects; must match the mapping')
    parser.add_argument('--probe-id', help='Stable UUID of this probe installation (required with --send)')
    parser.add_argument('--send', action='store_true', help='Send sanitized E5/E6 observations to the existing ingestion endpoint')
    parser.add_argument('--timeout', type=float, default=3, help='Per-I/O timeout, 0.5–10 seconds')
    parser.add_argument('--duration', type=float, default=5, help='Media window, 1–5 seconds')
    parser.add_argument('--max-duration', type=float, default=30, help='Total budget incl. TEARDOWN and delivery, 5–60 seconds')
    args = parser.parse_args(argv)
    if not (.5 <= args.timeout <= 10 and 1 <= args.duration <= 5 and 5 <= args.max_duration <= 60):
        parser.error('bounds')
    bound = [args.channel_id, args.channel_number, args.probe_id]
    if (args.send or any(v is not None for v in bound)) and any(v is None for v in bound):
        parser.error('binding')
    try:
        # Userinfo is refused; the host must be the configured Speco recorder.
        _, (_, host, _) = checked_url(args.uri, {'rtsp', 'rtsps'})
        local = _load_simple_env(DEFAULT_LOCAL_ENV)
        if host != local.get('PSOP_SPECO_HOST'):
            raise ProbeError()
        binding = None
        if args.channel_id is not None:
            binding = bind_channel(_load_speco_map(DEFAULT_LOCAL_MAP), args.channel_id, args.channel_number,
                                   args.probe_id, local.get('PSOP_SPECO_RECORDER_DEVICE_ID'))
        api_url = os.environ.get('PSOP_API_URL') or local.get('PSOP_API_URL')
        device_key = os.environ.get('PSOP_SPECO_RECORDER_DEVICE_KEY') or local.get('PSOP_SPECO_RECORDER_DEVICE_KEY')
        if args.send:
            if not api_url or not device_key:
                raise ProbeError()
            checked_url(api_url, {'http', 'https'})
        username = getpass.getpass('NVR RTSP username (hidden): ')
        password = getpass.getpass('NVR RTSP password (hidden): ')
        if not username or not password:
            raise ProbeError()
    except KeyboardInterrupt:
        return 130
    except Exception:
        print('CHECK_CONFIGURATION_ERROR: URI must be credential-free rtsp:// on PSOP_SPECO_HOST; '
              '--channel-id/--channel-number must match one speco.local.json channel; --probe-id must be a UUID.')
        return 2

    def expired(*_):
        raise ProbeError('TIMEOUT')
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, args.max_duration)
    try:
        budget = Budget(args.max_duration, args.timeout)
        summary, rows = check(args.uri, Credentials(username, password), budget, args.duration, binding=binding)
        if args.send:
            delivered = deliver(rows, api_url, binding['observerId'], device_key, budget)
            summary['delivery'] = 'DELIVERED' if delivered == len(rows) else 'DELIVERY_ERROR'
            summary['deliveredRows'] = delivered
        print(json.dumps(summary, sort_keys=True))
        ok = isinstance(summary['media'], dict) and summary['delivery'] in {'NOT_SENT', 'DELIVERED'}
        return 0 if ok else 1
    except KeyboardInterrupt:
        print('CHECK_INTERRUPTED')
        return 130
    except Exception:
        print('CHECK_INCOMPLETE')
        return 1
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


if __name__ == '__main__':
    raise SystemExit(main())
