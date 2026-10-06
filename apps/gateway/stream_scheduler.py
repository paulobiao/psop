#!/usr/bin/env python3
"""Foreground executor for periodic stream checks across recorders/channels.

It schedules the existing checks (today: NVR-mediated RTSP with an operator-
supplied URI, nvr_rtsp_check.check) and delivers their rows through the existing
ingestion endpoint (stream_probe.post_row). It never changes heartbeat,
connectivity, incidents, the Speco watcher, services or local runtime files
other than its own suspension state file.

Periodic sampling does not prove continuous availability: each row is only a
bounded observation valid for `evidenceValiditySeconds` after it was made.
"""
from __future__ import annotations

import errno
import fcntl
import getpass
import json
import os
import re
import select
import signal
import socket
import sys
import threading
import time
import uuid
import weakref
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import nvr_rtsp_check
from speco_n8nrl import _load_simple_env, _load_speco_map
from stream_probe import SafeParser, encode_row, evidence_endpoint, post_row
from stream_probe_common import Budget, Credentials, ProbeError, checked_url, http_post

API_MAX_VALIDITY = 120  # ingestion contract: expiresAt - observedAt <= 120 s
SCHEDULE = {  # name: (default, minimum, maximum)
    'intervalSeconds': (300, 60, 86400),
    'durationSeconds': (5, 1, 5),
    'timeoutSeconds': (3, 0.5, 10),
    'maxCheckSeconds': (30, 5, 60),
    'evidenceValiditySeconds': (60, 10, API_MAX_VALIDITY),
    'maxConcurrentRecorders': (2, 1, 16),
    'maxBackoffSeconds': (1800, 60, 86400),
    'deliverySeconds': (15, 2, 60),
    'maxPendingRows': (100, 2, 1000),
}
UNAVAILABLE = {'FAILED:UNREACHABLE', 'FAILED:TIMEOUT'}
SHUTDOWN_GRACE = 2.0


class ConfigError(ValueError):
    """Messages name fields/paths only, never configured values."""


@dataclass(frozen=True)
class Target:
    recorder: str
    observer_id: str
    probe_id: str
    device_id: str
    channel_number: int
    uri: str = field(repr=False)  # may carry a path token; never logged
    # How the URI-to-channel association is known: nvr_rtsp_check.uri_channel.
    uri_channel: str = 'OPERATOR_DECLARED'


def nvr_rtsp_manual_uri(target, credentials, budget, duration, validity):
    binding = {'deviceId': target.device_id, 'probeId': target.probe_id,
               'observerId': target.observer_id, 'channelNumber': target.channel_number}
    return nvr_rtsp_check.check(target.uri, credentials, budget, duration,
                                binding=binding, validity=validity)


# The scheduler <-> check boundary. A check is
#   check(target, credentials, budget, duration, validity) -> (summary, rows)
# where summary carries 'negotiation', 'media' and optional 'diagnostic' exactly
# like nvr_rtsp_check.check, and rows are ingestion-contract dicts sharing one
# fresh attemptId. Another vendor/access path is one more entry here.
INTEGRATIONS = {'NVR_RTSP_MANUAL_URI': nvr_rtsp_manual_uri}


def _fields(obj, where, required, optional=()):
    if not isinstance(obj, dict):
        raise ConfigError(f'{where}: must be an object')
    unknown = obj.keys() - set(required) - set(optional)
    if unknown:
        # Also rejects tenant/site scoping, passwords, keys: authorization comes
        # only from the recorder's own ingestion key on the API side.
        raise ConfigError(f'{where}: unsupported field(s) {sorted(unknown)}')
    missing = set(required) - obj.keys()
    if missing:
        raise ConfigError(f'{where}: missing field(s) {sorted(missing)}')
    return obj


def _uuid(value, where):
    try:
        if not isinstance(value, str):
            raise ValueError()
        return str(uuid.UUID(value))
    except ValueError:
        raise ConfigError(f'{where}: must be a UUID') from None


def _ref(value, where):
    """External secret/value reference; the value itself never lives in JSON."""
    if isinstance(value, dict) and set(value) == {'env'} and re.fullmatch(r'[A-Z_][A-Z0-9_]*', str(value['env'])):
        return value
    if isinstance(value, dict) and set(value) == {'envFile', 'key'} and isinstance(value['envFile'], str) \
            and re.fullmatch(r'[A-Z_][A-Z0-9_]*', str(value['key'])):
        return value
    if isinstance(value, dict) and set(value) == {'prompt'} and isinstance(value['prompt'], str) \
            and 0 < len(value['prompt']) <= 80:
        return value
    raise ConfigError(f'{where}: must be {{"env": NAME}}, {{"envFile": PATH, "key": NAME}} or {{"prompt": LABEL}}')


def load_config(path):
    path = Path(path)
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        raise ConfigError('config: unreadable JSON file') from None
    _fields(raw, 'config', ['version', 'probeId', 'apiUrl', 'recorders'], ['stateFile', 'schedule'])
    if raw['version'] != 1:
        raise ConfigError('config.version: must be 1')
    base = path.resolve().parent
    config = {'base': base, 'probeId': _uuid(raw['probeId'], 'config.probeId'),
              'apiUrl': _ref(raw['apiUrl'], 'config.apiUrl'),
              'stateFile': base / raw.get('stateFile', 'state/stream-scheduler-state.json')}

    schedule = _fields(raw.get('schedule', {}), 'config.schedule', [], SCHEDULE)
    config['schedule'] = s = {}
    for name, (default, low, high) in SCHEDULE.items():
        value = schedule.get(name, default)
        if type(value) not in {int, float} or not low <= value <= high:
            raise ConfigError(f'config.schedule.{name}: must be a number in [{low}, {high}]')
        if name in {'maxConcurrentRecorders', 'maxPendingRows'} and type(value) is not int:
            raise ConfigError(f'config.schedule.{name}: must be an integer')
        s[name] = value
    # Validity describes one sample; it must not bridge a missed/late sample.
    if s['evidenceValiditySeconds'] > s['intervalSeconds']:
        raise ConfigError('config.schedule: evidenceValiditySeconds must not exceed intervalSeconds')
    if s['maxCheckSeconds'] < s['durationSeconds'] + 2 * s['timeoutSeconds']:
        raise ConfigError('config.schedule: maxCheckSeconds must be >= durationSeconds + 2 * timeoutSeconds')
    if s['maxBackoffSeconds'] < s['intervalSeconds']:
        raise ConfigError('config.schedule: maxBackoffSeconds must be >= intervalSeconds')

    if not isinstance(raw['recorders'], list) or not raw['recorders']:
        raise ConfigError('config.recorders: must be a non-empty list')
    config['recorders'] = []
    recorder_ids, observer_ids, device_ids = set(), set(), set()
    for i, rec in enumerate(raw['recorders']):
        where = f'config.recorders[{i}]'
        _fields(rec, where, ['id', 'integration', 'deviceId', 'host', 'deviceKey', 'credentials', 'targets'],
                ['bindingSource'])
        if not isinstance(rec['id'], str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,64}', rec['id']) \
                or rec['id'] in recorder_ids:
            raise ConfigError(f'{where}.id: must be a unique [A-Za-z0-9._-]{{1,64}} name')
        recorder_ids.add(rec['id'])
        if rec['integration'] not in INTEGRATIONS:
            raise ConfigError(f'{where}.integration: must be one of {sorted(INTEGRATIONS)}')
        observer = _uuid(rec['deviceId'], f'{where}.deviceId')
        if observer in observer_ids:
            raise ConfigError(f'{where}.deviceId: recorder listed twice')
        observer_ids.add(observer)
        try:
            _, (_, host, _) = checked_url(f'rtsp://{rec["host"]}/', {'rtsp'})
        except (ProbeError, TypeError):
            raise ConfigError(f'{where}.host: must be a literal IP address') from None
        creds = _fields(rec['credentials'], f'{where}.credentials', ['username', 'password'])
        entry = {'id': rec['id'], 'integration': rec['integration'], 'observerId': observer, 'host': host,
                 'deviceKey': _ref(rec['deviceKey'], f'{where}.deviceKey'),
                 'username': _ref(creds['username'], f'{where}.credentials.username'),
                 'password': _ref(creds['password'], f'{where}.credentials.password'), 'targets': []}
        mapping = None
        if 'bindingSource' in rec:
            source = _fields(rec['bindingSource'], f'{where}.bindingSource', ['format', 'file'])
            if source['format'] != 'SPECO_MAP' or not isinstance(source['file'], str):
                raise ConfigError(f'{where}.bindingSource: format must be SPECO_MAP with a file path')
            try:
                mapping = _load_speco_map(base / Path(source['file']).expanduser())
            except Exception:
                raise ConfigError(f'{where}.bindingSource: mapping file unreadable or invalid') from None
        if not isinstance(rec['targets'], list) or not rec['targets']:
            raise ConfigError(f'{where}.targets: must be a non-empty list')
        channels = set()
        for j, tgt in enumerate(rec['targets']):
            twhere = f'{where}.targets[{j}]'
            _fields(tgt, twhere, ['channelNumber', 'deviceId', 'uri'], ['channelKey'])
            number = tgt['channelNumber']
            if type(number) is not int or not 1 <= number <= 65535 or number in channels:
                raise ConfigError(f'{twhere}.channelNumber: must be a unique integer 1-65535 for this recorder')
            channels.add(number)
            device = _uuid(tgt['deviceId'], f'{twhere}.deviceId')
            if device in device_ids or device in observer_ids:
                raise ConfigError(f'{twhere}.deviceId: camera already bound elsewhere or equals a recorder')
            device_ids.add(device)
            try:
                uri, (_, uri_host, _) = checked_url(tgt['uri'], {'rtsp', 'rtsps'})
            except ProbeError:
                raise ConfigError(f'{twhere}.uri: must be a credential-free rtsp:// URI with a literal IP') from None
            if uri_host != host:
                raise ConfigError(f'{twhere}.uri: host must be this recorder\'s host')
            try:
                uri_channel = nvr_rtsp_check.uri_channel(uri, number)
            except ProbeError:
                raise ConfigError(f'{twhere}.uri: chID does not select channelNumber') from None
            if mapping is not None:
                try:
                    bound = nvr_rtsp_check.bind_channel(mapping, tgt.get('channelKey'), number,
                                                        config['probeId'], observer)
                except Exception:
                    raise ConfigError(f'{twhere}: channelKey/channelNumber/recorder do not match bindingSource') from None
                if bound['deviceId'] != device:
                    raise ConfigError(f'{twhere}.deviceId: differs from bindingSource for this channel')
            entry['targets'].append(Target(rec['id'], observer, config['probeId'], device, number, tgt['uri'],
                                           uri_channel))
        # A whole recorder cycle, with delivery, must fit in one interval.
        if len(entry['targets']) * (s['maxCheckSeconds'] + s['deliverySeconds']) > s['intervalSeconds']:
            raise ConfigError(f'{where}.targets: too many targets for intervalSeconds '
                              '(targets * (maxCheckSeconds + deliverySeconds) must fit)')
        entry['bindingSource'] = mapping is not None
        config['recorders'].append(entry)
    return config


def resolve(ref, base, *, environ=os.environ, prompt=getpass.getpass, where='reference'):
    if 'env' in ref:
        value = environ.get(ref['env'])
    elif 'envFile' in ref:
        value = _load_simple_env(base / Path(ref['envFile']).expanduser()).get(ref['key'])
    else:
        value = prompt(f'{ref["prompt"]} (hidden): ')
    if not value:
        raise ConfigError(f'{where}: referenced value is not set')
    return value


def resolve_secrets(config, *, environ=os.environ, prompt=getpass.getpass, prompts=True):
    """All references resolved before any network I/O; nothing is echoed."""
    get = lambda ref, where: (None if 'prompt' in ref and not prompts else
                              resolve(ref, config['base'], environ=environ, prompt=prompt, where=where))
    api_url = get(config['apiUrl'], 'config.apiUrl')
    if api_url is not None:
        try:
            checked_url(api_url, {'http', 'https'})
        except ProbeError:
            raise ConfigError('config.apiUrl: must be an http(s) URL with a literal IP') from None
    secrets = {}
    for rec in config['recorders']:
        where = f'recorder {rec["id"]}'
        username, password = get(rec['username'], f'{where} username'), get(rec['password'], f'{where} password')
        secrets[rec['id']] = {
            'deviceKey': get(rec['deviceKey'], f'{where} deviceKey'),
            'credentials': Credentials(username, password) if username and password else None}
    return api_url, secrets


class SuspensionState:
    """Persistent, secret-free record of targets suspended after auth rejection.
    Only an explicit --resume clears an entry; restarts never do."""
    def __init__(self, path):
        self.path, self.lock = Path(path), threading.Lock()
        try:
            self.data = json.loads(self.path.read_text())
            if not isinstance(self.data.get('suspended'), dict):
                raise ValueError()
        except FileNotFoundError:
            self.data = {'suspended': {}}
        except (OSError, ValueError, AttributeError):
            raise ConfigError('stateFile: unreadable; fix or remove it deliberately') from None

    def get(self, key):
        return self.data['suspended'].get(key)

    def suspend(self, key, reason, detail):
        with self.lock:
            self.data['suspended'][key] = {'reason': reason, 'detail': detail,
                                           'since': datetime.now(timezone.utc).isoformat(timespec='seconds')}
            self._save()

    def resume(self, key):
        with self.lock:
            found = self.data['suspended'].pop(key, None) is not None
            if found:
                self._save()
            return found

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = self.path.with_suffix('.tmp')
        tmp.write_text(json.dumps(self.data, indent=2, sort_keys=True))
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)


def acquire_lock(state_file):
    """Exclusive flock next to the state file: one executor (or --resume) per
    installation/config. The kernel drops the lock when the process dies, even
    by SIGKILL, so a leftover file is harmless and never needs manual cleanup;
    its existence alone means nothing. Not reliable on network filesystems."""
    path = Path(state_file).with_name(Path(state_file).name + '.lock')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        raise ConfigError('stateFile: another stream_scheduler holds this installation\'s lock') from None
    return fd  # held until the process exits


def _cut(sock):
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass  # not connected yet, or already closed by its owner


class StopBudget(Budget):
    """Once shutdown starts, shrinks to a short grace, and its connections are
    cut (Runner.shutdown) so a thread blocked in connect/recv/send returns now."""
    def __init__(self, seconds, timeout, stop, track=lambda sock: None):
        super().__init__(seconds, timeout)
        self.stop, self.track = stop, track

    def remaining(self):
        if self.stop.is_set():
            self.end = min(self.end, time.monotonic() + SHUTDOWN_GRACE)
        return super().remaining()

    def connect(self, address, timeout=None, source_address=None):
        # Non-blocking connect polled in short slices, so stop aborts it.
        # ponytail: TLS (rtsps/https) re-wraps this socket after connect, so a
        # TLS read is not cut and ends at its per-I/O timeout (<= timeoutSeconds).
        sock = socket.socket(socket.AF_INET6 if ':' in address[0] else socket.AF_INET, socket.SOCK_STREAM)
        try:
            self.track(sock)
            sock.setblocking(False)
            end = time.monotonic() + (self.remaining() if timeout is None else timeout)
            error = sock.connect_ex(address)
            while error in {errno.EINPROGRESS, errno.EALREADY, errno.EWOULDBLOCK}:
                left = end - time.monotonic()
                if self.stop.is_set() or left <= 0:
                    raise TimeoutError()
                if select.select([], [sock], [], min(0.1, left))[1]:
                    error = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            if error:
                raise OSError(error, os.strerror(error))
            if self.stop.is_set():
                raise TimeoutError()
            sock.settimeout(timeout)
            return sock
        except BaseException:
            sock.close()
            raise


class RecorderRun:
    def __init__(self, recorder, max_pending):
        self.recorder = recorder
        self.next_due = 0.0
        self.running = False
        self.cycles = 0
        self.failures = 0
        # In-memory only: undelivered encoded rows, oldest first, resent unchanged.
        self.outbox = deque()
        self.max_pending = max_pending
        self.dropped = 0


def _emit(event):
    print(json.dumps(event, sort_keys=True), flush=True)


class Runner:
    def __init__(self, config, api_url, secrets, state, *, send, integrations=INTEGRATIONS,
                 post=http_post, clock=time.monotonic, spawn=None, emit=_emit):
        self.config, self.schedule = config, config['schedule']
        self.api_url, self.secrets, self.state, self.send = api_url, secrets, state, send
        self.integrations, self.post, self.clock = integrations, post, clock
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.threads = []
        self.sockets = weakref.WeakSet()  # open probe/delivery sockets, cut on shutdown
        self.spawn = spawn or self._thread
        self._emit = emit
        self.runs = [RecorderRun(r, self.schedule['maxPendingRows']) for r in config['recorders']]

    def emit(self, event, **fields):
        with self.lock:
            self._emit({'event': event, 'at': datetime.now(timezone.utc).isoformat(timespec='seconds'), **fields})

    def _thread(self, fn):
        self.threads = [worker for worker in self.threads if worker.is_alive()]
        thread = threading.Thread(target=fn, daemon=True)
        self.threads.append(thread)
        thread.start()

    def track(self, sock):
        with self.lock:
            self.sockets.add(sock)
            if self.stop.is_set():
                _cut(sock)

    def budget(self, seconds):
        return StopBudget(seconds, self.schedule['timeoutSeconds'], self.stop, self.track)

    def recorder_suspended(self, run):
        return self.state.get(f'recorder:{run.recorder["id"]}') is not None

    def tick(self):
        """Start due recorders; never a second cycle for a recorder that is running."""
        now = self.clock()
        with self.lock:
            active = sum(run.running for run in self.runs)
            due = [run for run in self.runs if not run.running and run.next_due <= now
                   and not self.recorder_suspended(run)]
            due.sort(key=lambda run: run.next_due)
            started = []
            for run in due[:max(0, self.schedule['maxConcurrentRecorders'] - active)]:
                run.running = True
                started.append(run)
        for run in started:
            self.spawn(lambda run=run: self._cycle(run))
        return started

    def _cycle(self, run):
        start = self.clock()
        try:
            outcome = self.cycle(run)
        except Exception:
            # A defect in one recorder's cycle never stops the executor.
            outcome = 'OK'
            self.emit('CYCLE_ERROR', recorder=run.recorder['id'])
        end = self.clock()
        with self.lock:
            run.cycles += 1
            if outcome == 'UNAVAILABLE':
                run.failures += 1
                delay = min(self.schedule['intervalSeconds'] * 2 ** run.failures, self.schedule['maxBackoffSeconds'])
            else:
                run.failures = 0
                delay = self.schedule['intervalSeconds']
            # Missed slots are not replayed: at most one cycle right after a long one.
            run.next_due = max(start + delay, end)
            run.running = False
        if outcome == 'UNAVAILABLE':
            self.emit('RECORDER_BACKOFF', recorder=run.recorder['id'], consecutiveFailures=run.failures,
                      nextCheckInSeconds=round(run.next_due - end, 3))

    def cycle(self, run):
        rec, s = run.recorder, self.schedule
        credentials = self.secrets[rec['id']]['credentials']
        check = self.integrations[rec['integration']]
        attempted = unavailable = 0
        for target in rec['targets']:
            if self.stop.is_set():
                return 'STOPPED'
            if self.recorder_suspended(run):
                break
            target_key = f'target:{rec["id"]}:{target.channel_number}'
            if self.state.get(target_key):
                self.emit('CHECK_SKIPPED', recorder=rec['id'], channelNumber=target.channel_number,
                          reason='SUSPENDED')
                continue
            attempted += 1
            started = self.clock()
            try:
                summary, rows = check(target, credentials, self.budget(s['maxCheckSeconds']),
                                      s['durationSeconds'], s['evidenceValiditySeconds'])
            except Exception:
                summary, rows = {'negotiation': 'FAILED:PROTOCOL_ERROR', 'media': 'NOT_ATTEMPTED',
                                 'error': 'CHECK_ERROR'}, []
            if self.stop.is_set():
                # A check cut short by shutdown is not a measurement of the stream.
                self.emit('CHECK_INTERRUPTED', recorder=rec['id'], channelNumber=target.channel_number)
                return 'STOPPED'
            negotiation = summary.get('negotiation')
            detail = (summary.get('diagnostic') or {}).get('detail')
            unavailable += negotiation in UNAVAILABLE
            delivery = self.deliver(run, rows) if self.send else {'status': 'NOT_SENT'}
            self.emit('CHECK', recorder=rec['id'], channelNumber=target.channel_number,
                      deviceId=target.device_id, uriChannel=target.uri_channel, attemptId=summary.get('attemptId'),
                      negotiation=negotiation, media=summary.get('media'),
                      **({'diagnostic': summary['diagnostic']} if summary.get('diagnostic') else {}),
                      **({'error': summary['error']} if summary.get('error') else {}),
                      decodedFrames='NOT_MEASURED', elapsedMs=int((self.clock() - started) * 1000),
                      delivery=delivery)
            if negotiation == 'FAILED:AUTHENTICATION_FAILED':
                # One rejected login suspends; retrying could lock the account.
                # 403 is a per-channel permission; anything else is the account.
                key = target_key if detail == 'FORBIDDEN' else f'recorder:{rec["id"]}'
                self.state.suspend(key, 'AUTHENTICATION_FAILED', detail)
                self.emit('SUSPENDED', key=key, detail=detail,
                          resume=f'--resume {key.split(":", 1)[1]}')
        return 'UNAVAILABLE' if attempted and unavailable == attempted else 'OK'

    def deliver(self, run, rows):
        """Queue this attempt's rows behind older pending ones and post in order,
        stopping at the first unavailability. Rows are resent byte-identical, so
        the API's sourceEventKey idempotency makes resends harmless."""
        keys = []
        for row in rows:
            try:
                body = encode_row(row)
            except ProbeError:
                continue
            if len(run.outbox) >= run.max_pending:
                run.outbox.popleft()
                run.dropped += 1
            run.outbox.append((row['sourceEventKey'], body))
            keys.append(row['sourceEventKey'])
        secrets = self.secrets[run.recorder['id']]
        url, headers = evidence_endpoint(self.api_url, run.recorder['observerId'], secrets['deviceKey'])
        budget = self.budget(self.schedule['deliverySeconds'])
        outcomes = {}
        while run.outbox and not self.stop.is_set():
            key, body = run.outbox[0]
            outcome = post_row(body, url, headers, budget, post=self.post)
            if outcome == 'UNAVAILABLE':
                break
            run.outbox.popleft()
            outcomes[key] = outcome
        mine = [outcomes.get(key, 'PENDING') for key in keys]
        stored = sum(o in {'ACCEPTED', 'DUPLICATE'} for o in mine)
        rejected, pending = mine.count('REJECTED'), mine.count('PENDING')
        status = ('DELIVERED' if stored == len(mine) else 'PENDING' if pending == len(mine)
                  else 'REJECTED' if rejected == len(mine) else 'PARTIAL')
        return {'status': status, 'rows': len(mine), 'stored': stored, 'rejected': rejected,
                'pending': pending, 'recorderPendingRows': len(run.outbox), 'droppedRows': run.dropped,
                'olderRowsDelivered': sum(
                    1 for k, outcome in outcomes.items()
                    if k not in keys and outcome in {'ACCEPTED', 'DUPLICATE'})}

    def runnable(self):
        return [run for run in self.runs if not self.recorder_suspended(run)]

    def run(self, *, once, wait=None):
        wait = wait or (lambda seconds: self.stop.wait(seconds))
        for run in self.runs:
            if self.recorder_suspended(run):
                self.emit('RECORDER_SKIPPED', recorder=run.recorder['id'], reason='SUSPENDED',
                          resume=f'--resume {run.recorder["id"]}')
        while not self.stop.is_set():
            self.tick()
            with self.lock:
                busy = any(run.running for run in self.runs)
                pending = [run for run in self.runnable() if not run.running]
                done = once and not busy and all(run.cycles for run in pending)
            if done or (not busy and not pending):
                break
            upcoming = [run.next_due for run in pending]
            wait(max(0.05, min(1.0, min(upcoming) - self.clock())) if upcoming else 0.2)
        return 0 if self.runnable() else 3

    def shutdown(self, join_seconds):
        self.stop.set()
        with self.lock:
            # Unblocks in-flight connect/recv/send at once; owners still close.
            for sock in list(self.sockets):
                _cut(sock)
        deadline = time.monotonic() + join_seconds
        for thread in self.threads:
            thread.join(max(0, deadline - time.monotonic()))
        self.emit('STOPPED', undeliveredRows=sum(len(run.outbox) for run in self.runs),
                  stillRunning=sum(thread.is_alive() for thread in self.threads))


def main(argv=None, *, environ=os.environ, prompt=getpass.getpass, runner_class=Runner):
    parser = SafeParser(description='Foreground periodic stream checks for configured recorders/channels. '
                                    'Evidence is sent only with --send. Stop with Ctrl+C.')
    parser.add_argument('--config', required=True, help='Local JSON config (see stream-scheduler.example.json)')
    parser.add_argument('--once', action='store_true', help='One cycle per recorder, then exit')
    parser.add_argument('--send', action='store_true', help='Send sanitized E5/E6 rows to the ingestion endpoint')
    parser.add_argument('--validate', action='store_true', help='Validate config, bindings and references; no network')
    parser.add_argument('--status', action='store_true', help='Show suspensions; no network')
    parser.add_argument('--resume', metavar='RECORDER[:CHANNEL]', help='Clear one suspension explicitly; no network')
    args = parser.parse_args(argv)
    lock = None
    try:
        try:
            config = load_config(args.config)
            if args.resume is not None or not (args.status or args.validate):
                # Before reading state: a running executor would overwrite a resume.
                lock = acquire_lock(config['stateFile'])
            state = SuspensionState(config['stateFile'])
            if args.resume is not None:
                kind = 'target' if ':' in args.resume else 'recorder'
                found = state.resume(f'{kind}:{args.resume}')
                _emit({'event': 'RESUMED' if found else 'NOT_SUSPENDED', 'key': f'{kind}:{args.resume}'})
                return 0 if found else 1
            if args.status:
                _emit({'event': 'STATUS', 'suspended': state.data['suspended']})
                return 0
            api_url, secrets = resolve_secrets(config, environ=environ, prompt=prompt, prompts=not args.validate)
            if args.validate:
                _emit({'event': 'CONFIG_VALID', 'recorders': [
                    {'id': r['id'], 'integration': r['integration'],
                     'channels': [{'channelNumber': t.channel_number, 'uriChannel': t.uri_channel,
                                   'binding': 'BINDING_SOURCE' if r['bindingSource'] else 'OPERATOR_DECLARED'}
                                  for t in r['targets']],
                     'suspended': state.get(f'recorder:{r["id"]}') is not None} for r in config['recorders']],
                    'schedule': config['schedule']})
                return 0
        except KeyboardInterrupt:
            return 130
        except ConfigError as error:
            print(f'SCHEDULER_CONFIGURATION_ERROR: {error}')
            return 2

        runner = runner_class(config, api_url, secrets, state, send=args.send)
        s = config['schedule']
        def terminate(*_):
            raise KeyboardInterrupt()
        previous = signal.signal(signal.SIGTERM, terminate)
        runner.emit('STARTED', mode='ONCE' if args.once else 'PERIODIC', send=args.send,
                    recorders=len(config['recorders']), intervalSeconds=s['intervalSeconds'],
                    evidenceValiditySeconds=s['evidenceValiditySeconds'])
        try:
            code = runner.run(once=args.once)
            runner.shutdown(s['maxCheckSeconds'] + s['deliverySeconds'])
            return code
        except KeyboardInterrupt:
            try:
                # In-flight sockets are cut at once (no TEARDOWN: the RTSP session
                # ends with its TCP connection) and closed by their owners; the
                # join below bounds the wait. A second Ctrl+C aborts.
                runner.shutdown(SHUTDOWN_GRACE + s['timeoutSeconds'] + 1)
            except KeyboardInterrupt:
                os._exit(130)
            return 130
        finally:
            signal.signal(signal.SIGTERM, previous)
    finally:
        if lock is not None:
            os.close(lock)  # releases the flock


if __name__ == '__main__':
    sys.exit(main())
