"""Periodic stream executor: simulated clock, threads, RTSP and API only."""
from __future__ import annotations

import contextlib
import copy
import io
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import unittest.mock
import uuid
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import nvr_rtsp_check
import stream_scheduler as sched
from rtsp_stream import RtspProbe
from stream_probe import observation
from stream_probe_common import ProbeError, http_post
from test_stream_probe import RtspFixture, SECRET, USER

GATEWAY = Path(__file__).resolve().parents[1]
DEVICE_KEY = 'fixture-only-device-key'
ENV = {'API_URL': 'http://127.0.0.1:3000/api/v1', 'NVR_USER': USER, 'NVR_PASS': SECRET, 'DEVICE_KEY': DEVICE_KEY}


def recorder(n, channels=(1, 2), host='127.0.0.1'):
    return {
        'id': f'rec-{n}', 'integration': 'NVR_RTSP_MANUAL_URI',
        'deviceId': f'{n}0000000-0000-4000-8000-000000000000', 'host': host,
        'deviceKey': {'env': 'DEVICE_KEY'},
        'credentials': {'username': {'env': 'NVR_USER'}, 'password': {'env': 'NVR_PASS'}},
        'targets': [{'channelNumber': c, 'deviceId': f'{n}000000{c}-0000-4000-8000-000000000000',
                     'uri': f'rtsp://{host}:8554/{SECRET}/ch{c}?token={SECRET}'} for c in channels]}


def base_config(recorders=2, **schedule):
    return {'version': 1, 'probeId': '22222222-2222-4222-8222-222222222222',
            'apiUrl': {'env': 'API_URL'}, 'stateFile': 'state.json',
            'schedule': {'intervalSeconds': 120, 'evidenceValiditySeconds': 60, **schedule},
            'recorders': [recorder(n + 1) for n in range(recorders)]}


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def wait(self, seconds):
        self.now += seconds


class Checks:
    """Scripted outcomes per (recorder, channel); rows shaped like the NVR check."""
    def __init__(self, clock, script=None, default='OK'):
        self.clock, self.script, self.default = clock, script or {}, default
        self.calls = []
        self.hook = None

    def __call__(self, target, credentials, budget, duration, validity):
        assert credentials.username == USER and credentials.password == SECRET
        key = (target.recorder, target.channel_number)
        self.calls.append((key, self.clock()))
        if self.hook:
            self.hook(target)
        queue = self.script.get(key, [])
        outcome = queue.pop(0) if queue else self.default
        self.clock.now += 7  # a check takes simulated time
        if outcome == 'RAISE':
            raise RuntimeError(f'Authorization: {SECRET}')
        binding = {'deviceId': target.device_id, 'probeId': target.probe_id, 'channelNumber': target.channel_number}
        endpoint = nvr_rtsp_check.nvr_endpoint(target.uri, target.channel_number)
        attempt = str(uuid.uuid4())
        row = lambda level, **kw: observation(binding, level, endpoint=endpoint, attemptId=attempt,
                                              validity=validity, **kw)
        summary = {'attemptId': attempt, 'media': 'NOT_ATTEMPTED'}
        if outcome == 'OK':
            media = {'measurement': 'RTP_VIDEO_PACKETS', 'count': 10, 'windowMs': 5000,
                     'lastReceivedAt': datetime.now().astimezone().isoformat()}
            summary.update(negotiation='SUCCEEDED', media={'result': 'SUCCEEDED', 'count': 10})
            return summary, [row('E5_RTSP_SESSION_NEGOTIATED', negotiation={}),
                             row('E6_FRAMES_RECEIVED', negotiation={}, media=media)]
        reason = {'UNREACHABLE': 'UNREACHABLE', 'TIMEOUT': 'TIMEOUT'}.get(outcome, 'AUTHENTICATION_FAILED')
        summary['negotiation'] = f'FAILED:{reason}'
        if reason == 'AUTHENTICATION_FAILED':
            summary['diagnostic'] = {'stage': 'DESCRIBE', 'status': 403 if outcome == 'FORBIDDEN' else 401,
                                     'detail': 'FORBIDDEN' if outcome == 'FORBIDDEN' else 'CREDENTIALS_REJECTED'}
        return summary, [row('E5_RTSP_SESSION_NEGOTIATED', result='FAILED', reason=reason),
                         row('E6_FRAMES_RECEIVED', result='NOT_OBSERVED', reason='NOT_ATTEMPTED')]


class Api:
    """Idempotent like the ledger: a repeated sourceEventKey is accepted: 0."""
    def __init__(self, statuses=None):
        self.statuses = statuses or []
        self.bodies, self.stored = [], {}

    def __call__(self, url, body, headers, budget, max_bytes):
        assert url == 'http://127.0.0.1:3000/api/v1/telemetry/stream-evidence'
        self.bodies.append((body, headers))
        status = self.statuses.pop(0) if self.statuses else 201
        if status == 'DOWN':
            raise OSError('connection refused')
        if status != 201:
            return status, {}, b'{}'
        row = json.loads(body)
        new = row['sourceEventKey'] not in self.stored
        self.stored.setdefault(row['sourceEventKey'], body)
        return 201, {}, json.dumps({'accepted': int(new)}).encode()


class Harness:
    def __init__(self, test, config=None, *, send=True, script=None, api=None, defer=False, default='OK'):
        self.dir = Path(tempfile.mkdtemp())
        test.addCleanup(shutil.rmtree, self.dir)
        self.path = self.dir / 'stream-scheduler.local.json'
        self.path.write_text(json.dumps(config or base_config()))
        self.config = sched.load_config(self.path)
        self.api_url, self.secrets = sched.resolve_secrets(self.config, environ=ENV, prompt=None)
        self.clock = Clock()
        self.checks = Checks(self.clock, script, default)
        self.api = api or Api()
        self.events = []
        self.deferred = []
        self.state = sched.SuspensionState(self.config['stateFile'])
        self.runner = sched.Runner(self.config, self.api_url, self.secrets, self.state, send=send,
                                   integrations={'NVR_RTSP_MANUAL_URI': self.checks}, post=self.api,
                                   clock=self.clock, emit=self.events.append,
                                   spawn=self.deferred.append if defer else (lambda fn: fn()))

    def of(self, name):
        return [e for e in self.events if e['event'] == name]

    def run_until(self, seconds, once=False):
        end = self.clock.now + seconds
        def wait(step):
            self.clock.wait(step)
            if self.clock.now >= end:
                self.runner.stop.set()
        return self.runner.run(once=once, wait=wait)


class ConfigTests(unittest.TestCase):
    def load(self, config):
        path = Path(tempfile.mkdtemp()) / 'c.json'
        self.addCleanup(shutil.rmtree, path.parent)
        path.write_text(json.dumps(config))
        return sched.load_config(path)

    def test_valid_config_has_no_fixed_hardware_and_keeps_probe_id(self):
        config = self.load(base_config())
        self.assertEqual({t.probe_id for r in config['recorders'] for t in r['targets']},
                         {'22222222-2222-4222-8222-222222222222'})
        self.assertEqual(len([t for r in config['recorders'] for t in r['targets']]), 4)

    def test_rejects_unsafe_or_incompatible_configuration(self):
        def mutate(fn):
            config = base_config()
            fn(config)
            return config
        rec = lambda c: c['recorders'][0]
        cases = {
            'tenant scope': lambda c: c.update(tenantId='x'),
            'site scope': lambda c: rec(c).update(siteId='x'),
            'inline password': lambda c: rec(c)['credentials'].update(password='hunter2'),
            'inline device key': lambda c: rec(c).update(deviceKey='k'),
            'bad env name': lambda c: rec(c).update(deviceKey={'env': 'lower'}),
            'probe not uuid': lambda c: c.update(probeId='probe-1'),
            'duplicate channel': lambda c: rec(c)['targets'][1].update(channelNumber=1),
            'camera on two recorders': lambda c: c['recorders'][1]['targets'][0].update(
                deviceId=rec(c)['targets'][0]['deviceId']),
            'camera is the recorder': lambda c: rec(c)['targets'][0].update(deviceId=rec(c)['deviceId']),
            'duplicate recorder': lambda c: c['recorders'][1].update(id='rec-1'),
            'uri on another host': lambda c: rec(c)['targets'][0].update(uri='rtsp://192.0.2.9/ch1'),
            'uri with credentials': lambda c: rec(c)['targets'][0].update(uri=f'rtsp://u:{SECRET}@127.0.0.1/x'),
            'hostname': lambda c: rec(c).update(host='nvr.example.test'),
            'unknown integration': lambda c: rec(c).update(integration='VENDOR_X'),
            'validity beyond interval': lambda c: c['schedule'].update(intervalSeconds=60, evidenceValiditySeconds=90),
            'validity beyond API': lambda c: c['schedule'].update(intervalSeconds=600, evidenceValiditySeconds=180),
            'interval too short': lambda c: c['schedule'].update(intervalSeconds=30, evidenceValiditySeconds=30),
            'cycle longer than interval': lambda c: rec(c)['targets'].extend(
                {'channelNumber': n, 'deviceId': str(uuid.uuid4()), 'uri': f'rtsp://127.0.0.1/c{n}'}
                for n in range(3, 6)),
            'check budget below window': lambda c: c['schedule'].update(maxCheckSeconds=5, durationSeconds=5),
            'no concurrency': lambda c: c['schedule'].update(maxConcurrentRecorders=0),
            'fractional concurrency': lambda c: c['schedule'].update(maxConcurrentRecorders=1.5),
            'float concurrency': lambda c: c['schedule'].update(maxConcurrentRecorders=2.0),
            'fractional queue limit': lambda c: c['schedule'].update(maxPendingRows=2.5),
            'float queue limit': lambda c: c['schedule'].update(maxPendingRows=100.0),
        }
        for name, fn in cases.items():
            with self.subTest(name), self.assertRaises(sched.ConfigError) as ctx:
                self.load(mutate(fn))
            for value in [SECRET, 'hunter2', '192.0.2.9', 'nvr.example.test']:
                self.assertNotIn(value, str(ctx.exception))

    def test_binding_source_cross_checks_channel_and_camera(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        config = base_config(recorders=1)
        rec = config['recorders'][0]
        mapping = {'recorder': {'deviceId': rec['deviceId']}, 'channels': {
            '{a}': {'channelNumber': 1, 'deviceId': rec['targets'][0]['deviceId']},
            '{b}': {'channelNumber': 2, 'deviceId': rec['targets'][1]['deviceId']}}}
        (tmp / 'map.json').write_text(json.dumps(mapping))
        rec['bindingSource'] = {'format': 'SPECO_MAP', 'file': 'map.json'}
        rec['targets'][0]['channelKey'], rec['targets'][1]['channelKey'] = '{a}', '{b}'
        (tmp / 'c.json').write_text(json.dumps(config))
        sched.load_config(tmp / 'c.json')
        for broken in [lambda c: c['recorders'][0]['targets'][0].update(channelKey='{b}'),
                       lambda c: c['recorders'][0]['targets'][0].pop('channelKey'),
                       lambda c: c['recorders'][0].update(deviceId=str(uuid.uuid4()))]:
            bad = copy.deepcopy(config)
            broken(bad)
            (tmp / 'c.json').write_text(json.dumps(bad))
            with self.assertRaises(sched.ConfigError):
                sched.load_config(tmp / 'c.json')

    def test_example_config_is_valid_with_its_own_synthetic_mapping(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        example = json.loads((GATEWAY / 'stream-scheduler.example.json').read_text())
        rec = example['recorders'][0]
        (tmp / 'speco.local.json').write_text(json.dumps({'recorder': {'deviceId': rec['deviceId']}, 'channels': {
            t['channelKey']: {'channelNumber': t['channelNumber'], 'deviceId': t['deviceId']}
            for t in rec['targets']}}))
        (tmp / 'c.json').write_text(json.dumps(example))
        config = sched.load_config(tmp / 'c.json')
        self.assertEqual([len(r['targets']) for r in config['recorders']], [2, 1])
        for rec in example['recorders']:
            refs = [rec['deviceKey'], *rec['credentials'].values()]
            self.assertTrue(all(isinstance(ref, dict) and set(ref) <= {'env', 'envFile', 'key', 'prompt'}
                                for ref in refs))

    def test_missing_secret_reference_fails_before_network(self):
        h_env = dict(ENV)
        del h_env['NVR_PASS']
        path = Path(tempfile.mkdtemp()) / 'c.json'
        self.addCleanup(shutil.rmtree, path.parent)
        path.write_text(json.dumps(base_config()))
        with self.assertRaises(sched.ConfigError) as ctx:
            sched.resolve_secrets(sched.load_config(path), environ=h_env, prompt=None)
        self.assertIn('password', str(ctx.exception))


class ExecutionTests(unittest.TestCase):
    def test_once_checks_every_target_of_every_recorder_with_fresh_attempts(self):
        h = Harness(self)
        self.assertEqual(h.run_until(1000, once=True), 0)
        checks = h.of('CHECK')
        self.assertEqual([(c['recorder'], c['channelNumber']) for c in checks],
                         [('rec-1', 1), ('rec-1', 2), ('rec-2', 1), ('rec-2', 2)])
        self.assertTrue(all(c['delivery']['status'] == 'DELIVERED' for c in checks))
        rows = [json.loads(b) for b, _ in h.api.bodies]
        self.assertEqual(len({r['attemptId'] for r in rows}), 4)
        self.assertEqual({r['probeId'] for r in rows}, {'22222222-2222-4222-8222-222222222222'})
        self.assertEqual({r['level'] for r in rows}, {'E5_RTSP_SESSION_NEGOTIATED', 'E6_FRAMES_RECEIVED'})
        for r in rows:
            self.assertEqual((r['endpoint']['access'], r['endpoint']['discoveryMethod']),
                             ('NVR_MEDIATED', 'MANUAL_OPERATOR_INPUT'))
            observed = datetime.fromisoformat(r['observedAt'].replace('Z', '+00:00'))
            expires = datetime.fromisoformat(r['expiresAt'].replace('Z', '+00:00'))
            self.assertEqual((expires - observed).total_seconds(), 60)
        # Each recorder authenticates as itself; a camera goes only to its recorder.
        for body, headers in h.api.bodies:
            row = json.loads(body)
            self.assertEqual(row['deviceId'][0], headers['x-device-id'][0])
            self.assertEqual(headers['x-device-key'], DEVICE_KEY)
        text = json.dumps(h.events)
        for value in [SECRET, USER, DEVICE_KEY, 'rtsp://', 'token']:
            self.assertNotIn(value, text)

    def test_no_overlap_on_one_recorder_and_concurrency_limit(self):
        config = base_config(recorders=3, maxConcurrentRecorders=2)
        h = Harness(self, config, defer=True)
        self.assertEqual(len(h.runner.tick()), 2)
        h.clock.now += 10_000  # far past every interval while cycles still run
        self.assertEqual(h.runner.tick(), [])
        self.assertEqual(len(h.deferred), 2)
        h.deferred.pop(0)()  # rec-1 finishes: the free slot goes to rec-3, not rec-1 again
        started = h.runner.tick()
        self.assertEqual([r.recorder['id'] for r in started], ['rec-3'])
        self.assertEqual(h.runner.tick(), [])
        for fn in h.deferred[:]:
            fn()
        h.clock.now += 120
        self.assertEqual(len(h.runner.tick()), 2)  # all due again, still capped at 2

    def test_long_cycle_is_followed_by_one_cycle_not_a_replay_burst(self):
        h = Harness(self, base_config(recorders=1))
        slow = [True]
        def hook(target):
            if slow and target.channel_number == 2:
                slow.pop()
                h.clock.now += 1000  # ~8 intervals missed
        h.checks.hook = hook
        h.run_until(1400)
        starts = [t for (key, t) in h.checks.calls if key == ('rec-1', 1)]
        gaps = [round(b - a) for a, b in zip(starts, starts[1:])]
        self.assertEqual(gaps[0], 1014)  # right after the long cycle ended
        self.assertEqual(set(gaps[1:]), {120})

    def test_periodic_interval_and_one_failing_target_does_not_stop_others(self):
        h = Harness(self, base_config(recorders=1), script={('rec-1', 1): ['RAISE']})
        h.run_until(3 * 120 + 1)
        starts = [t for (key, t) in h.checks.calls if key == ('rec-1', 1)]
        self.assertEqual(len(starts), 4)
        self.assertEqual([round(b - a) for a, b in zip(starts, starts[1:])], [120] * 3)
        failed = h.of('CHECK')[0]
        self.assertEqual((failed['channelNumber'], failed['error'], failed['delivery']['status']),
                         (1, 'CHECK_ERROR', 'DELIVERED'))
        self.assertEqual(h.of('CHECK')[1]['negotiation'], 'SUCCEEDED')
        self.assertNotIn(SECRET, json.dumps(h.events))

    def test_unavailable_recorder_backs_off_bounded_then_recovers(self):
        config = base_config(recorders=2, maxBackoffSeconds=600)
        down = ['UNREACHABLE'] * 4
        h = Harness(self, config, script={('rec-1', 1): list(down), ('rec-1', 2): ['TIMEOUT'] * 4})
        h.run_until(3000)
        rec1 = [t for (key, t) in h.checks.calls if key == ('rec-1', 1)]
        gaps = [round(b - a) for a, b in zip(rec1, rec1[1:])]
        # 240, 480, 600 (capped), 600, then back to the normal interval.
        self.assertEqual(gaps[:5], [240, 480, 600, 600, 120])
        self.assertEqual([e['consecutiveFailures'] for e in h.of('RECORDER_BACKOFF')], [1, 2, 3, 4])
        # The other recorder keeps its own rhythm.
        rec2 = [t for (key, t) in h.checks.calls if key == ('rec-2', 1)]
        self.assertTrue(all(round(b - a) == 120 for a, b in zip(rec2, rec2[1:])))
        # Failed attempts are still evidence (FAILED/UNREACHABLE), never success.
        failed = [json.loads(b) for b, _ in h.api.bodies if json.loads(b)['result'] == 'FAILED']
        self.assertEqual({r['reason'] for r in failed}, {'UNREACHABLE', 'TIMEOUT'})

    def test_rejected_credentials_suspend_the_recorder_persistently(self):
        h = Harness(self, script={('rec-1', 1): ['AUTH']})
        h.run_until(1000)
        self.assertEqual([k for (k, _) in h.checks.calls if k[0] == 'rec-1'], [('rec-1', 1)])
        self.assertGreater(len([k for (k, _) in h.checks.calls if k[0] == 'rec-2']), 3)
        self.assertEqual(h.of('SUSPENDED'), [dict(h.of('SUSPENDED')[0], key='recorder:rec-1',
                                                  detail='CREDENTIALS_REJECTED', resume='--resume rec-1')])
        # The failed attempt itself is recorded, once.
        failed = [json.loads(b) for b, _ in h.api.bodies if json.loads(b)['reason'] == 'AUTHENTICATION_FAILED']
        self.assertEqual(len(failed), 1)
        # A restart does not retry; only an explicit resume does.
        again = Harness(self)
        again.state, again.runner.state = h.state, h.state
        again.run_until(200, once=True)
        self.assertNotIn('rec-1', {k[0] for (k, _) in again.checks.calls})
        self.assertEqual(again.of('RECORDER_SKIPPED')[0]['recorder'], 'rec-1')
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(sched.main(['--config', str(h.path), '--resume', 'rec-1'], environ=ENV), 0)
        self.assertIn('RESUMED', out.getvalue())
        self.assertIsNone(sched.SuspensionState(h.config['stateFile']).get('recorder:rec-1'))

    def test_forbidden_channel_suspends_only_that_target(self):
        h = Harness(self, base_config(recorders=1), script={('rec-1', 1): ['FORBIDDEN']})
        h.run_until(400)
        calls = [k for (k, _) in h.checks.calls]
        self.assertEqual(calls.count(('rec-1', 1)), 1)
        self.assertGreater(calls.count(('rec-1', 2)), 2)
        self.assertEqual(h.of('SUSPENDED')[0]['key'], 'target:rec-1:1')
        self.assertEqual(h.of('CHECK_SKIPPED')[0]['channelNumber'], 1)

    def test_all_recorders_suspended_exits_distinctly(self):
        h = Harness(self, base_config(recorders=1), script={('rec-1', 1): ['AUTH']})
        self.assertEqual(h.run_until(10_000), 3)


class DeliveryTests(unittest.TestCase):

    def test_older_delivery_count_excludes_rejected_rows(self):
        api = Api([400, 201, 201])
        h = Harness(self, base_config(recorders=1), api=api)
        run = h.runner.runs[0]
        rows = [{'sourceEventKey': str(uuid.uuid4())} for _ in range(3)]
        encoded = [sched.encode_row(row) for row in rows]
        # The third row already exists: the API will report a duplicate.
        api.stored[rows[2]['sourceEventKey']] = encoded[2]
        for row, body in zip(rows, encoded):
            run.outbox.append((row['sourceEventKey'], body))
        result = h.runner.deliver(run, [])
        self.assertEqual(result['olderRowsDelivered'], 2)
        self.assertEqual(result['recorderPendingRows'], 0)
        self.assertNotIn(rows[0]['sourceEventKey'], api.stored)
        self.assertIn(rows[1]['sourceEventKey'], api.stored)
        self.assertEqual(len(api.bodies), 3)

    def test_api_outage_keeps_rows_and_resends_identical_bytes_without_backoff(self):
        api = Api(['DOWN', 503, 'DOWN'])
        h = Harness(self, base_config(recorders=1), api=api)
        h.run_until(130)
        checks = h.of('CHECK')
        self.assertEqual([c['delivery']['status'] for c in checks], ['PENDING', 'PENDING', 'PENDING', 'DELIVERED'])
        self.assertEqual(checks[3]['delivery']['olderRowsDelivered'], 6)
        # Stop at the first unavailability: one post per flush while the API is down.
        self.assertEqual(len(api.bodies), 1 + 1 + 1 + 8)
        # Resent bytes are identical: identifiers, observedAt and expiresAt unchanged.
        first = api.bodies[0][0]
        self.assertEqual([b for b, _ in api.bodies].count(first), 4)
        self.assertEqual(len(api.stored), 8)
        # Delivery trouble is not equipment unavailability: normal interval kept.
        self.assertEqual(h.of('RECORDER_BACKOFF'), [])
        self.assertEqual({c['negotiation'] for c in checks}, {'SUCCEEDED'})

    def test_partial_delivery_is_explicit_and_completed_later(self):
        api = Api([201, 503])
        h = Harness(self, base_config(recorders=1), api=api)
        h.run_until(10, once=True)
        first = h.of('CHECK')[0]['delivery']
        self.assertEqual((first['status'], first['stored'], first['pending']), ('PARTIAL', 1, 1))
        self.assertEqual(h.of('CHECK')[1]['delivery']['olderRowsDelivered'], 1)
        self.assertEqual(len(api.stored), 4)

    def test_duplicate_is_delivered_and_rejection_is_not_resent(self):
        api = Api([400])
        h = Harness(self, base_config(recorders=1), api=api)
        h.run_until(130)
        first = h.of('CHECK')[0]['delivery']
        self.assertEqual((first['status'], first['rejected'], first['stored']), ('PARTIAL', 1, 1))
        rejected = api.bodies[0][0]
        self.assertEqual([b for b, _ in api.bodies].count(rejected), 1)
        # A replayed row the API already has counts as delivered (accepted: 0).
        run = h.runner.runs[0]
        h.runner.stop.clear()
        run.outbox.append((json.loads(api.bodies[1][0])['sourceEventKey'], api.bodies[1][0]))
        self.assertEqual(h.runner.deliver(run, [])['recorderPendingRows'], 0)

    def test_pending_rows_are_bounded_and_drops_are_reported(self):
        api = Api(['DOWN'] * 50)
        h = Harness(self, base_config(recorders=1, maxPendingRows=3), api=api)
        h.run_until(10, once=True)
        last = h.of('CHECK')[-1]['delivery']
        self.assertEqual((last['recorderPendingRows'], last['droppedRows']), (3, 1))

    def test_without_send_nothing_is_posted(self):
        h = Harness(self, send=False)
        h.run_until(10, once=True)
        self.assertEqual(h.api.bodies, [])
        self.assertEqual({c['delivery']['status'] for c in h.of('CHECK')}, {'NOT_SENT'})


class ShutdownTests(unittest.TestCase):

    def test_finished_threads_are_pruned_and_active_threads_preserved(self):
        h = Harness(self, base_config(recorders=1), send=False)
        release = threading.Event()
        h.runner._thread(release.wait)
        active = h.runner.threads[-1]
        try:
            for _ in range(20):
                h.runner._thread(lambda: None)
                finished = h.runner.threads[-1]
                finished.join(timeout=2)
                self.assertFalse(finished.is_alive())
                self.assertIn(active, h.runner.threads)
                self.assertTrue(active.is_alive())
                self.assertLessEqual(len(h.runner.threads), 2)
        finally:
            release.set()
            h.runner.shutdown(2)
        self.assertEqual(h.of('STOPPED')[-1]['stillRunning'], 0)

    def test_interrupted_check_produces_no_evidence_and_no_new_work(self):
        h = Harness(self, base_config(recorders=1))
        h.checks.hook = lambda target: h.runner.stop.set()
        self.assertEqual(h.runner.run(once=False, wait=h.clock.wait), 0)
        self.assertEqual(len(h.checks.calls), 1)
        self.assertEqual(h.of('CHECK_INTERRUPTED')[0]['channelNumber'], 1)
        self.assertEqual((h.of('CHECK'), h.api.bodies), ([], []))

    def test_stop_budget_shrinks_to_grace(self):
        stop = threading.Event()
        budget = sched.StopBudget(60, 3, stop)
        self.assertGreater(budget.end - __import__('time').monotonic(), 50)
        stop.set()
        self.assertLessEqual(budget.remaining(), sched.SHUTDOWN_GRACE)

    def test_threaded_shutdown_joins_workers(self):
        h = Harness(self, base_config(recorders=2))
        release = threading.Event()
        h.checks.hook = lambda target: release.wait(2)
        h.runner.spawn = h.runner._thread
        h.runner.tick()
        h.runner.shutdown(3)
        stopped = h.of('STOPPED')[0]
        self.assertEqual(stopped['stillRunning'], 0)
        self.assertEqual(len(h.of('CHECK_INTERRUPTED')), 2)
        self.assertEqual(h.api.bodies, [])


class IdentityTests(unittest.TestCase):
    def config(self, *uris):
        config = base_config(recorders=1)
        for target, uri in zip(config['recorders'][0]['targets'], uris):
            target['uri'] = uri
        path = Path(tempfile.mkdtemp()) / 'c.json'
        self.addCleanup(shutil.rmtree, path.parent)
        path.write_text(json.dumps(config))
        return path

    def test_speco_chid_of_another_channel_fails_before_network(self):
        for uri in ['rtsp://127.0.0.1:554/chID=2&streamType=main&linkType=tcp', 'rtsp://127.0.0.1:554/?chID=2']:
            path = self.config(uri)  # target 0 is bound to channel 1
            with self.subTest(uri=uri), self.assertRaises(sched.ConfigError) as ctx:
                sched.load_config(path)
            self.assertIn('targets[0].uri', str(ctx.exception))
            out = io.StringIO()
            with unittest.mock.patch.object(socket, 'socket') as sock, contextlib.redirect_stdout(out):
                self.assertEqual(sched.main(['--config', str(path), '--once', '--send'], environ=ENV), 2)
            sock.assert_not_called()
            self.assertNotIn('rtsp://', out.getvalue())

    def test_chid_match_is_verified_and_unknown_format_stays_declared(self):
        path = self.config('rtsp://127.0.0.1:554/chID=1&streamType=main')
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(sched.main(['--config', str(path), '--validate'], environ=ENV), 0)
        channels = json.loads(out.getvalue())['recorders'][0]['channels']
        self.assertEqual(channels, [
            {'channelNumber': 1, 'uriChannel': 'URI_CHID_MATCHED', 'binding': 'OPERATOR_DECLARED'},
            {'channelNumber': 2, 'uriChannel': 'OPERATOR_DECLARED', 'binding': 'OPERATOR_DECLARED'}])
        h = Harness(self, json.loads(path.read_text()))
        h.run_until(10, once=True)
        self.assertEqual([c['uriChannel'] for c in h.of('CHECK')], ['URI_CHID_MATCHED', 'OPERATOR_DECLARED'])


HOLD_LOCK = """
import sys, time
sys.path.insert(0, sys.argv[1])
import stream_scheduler
stream_scheduler.acquire_lock(sys.argv[2])
print('LOCKED', flush=True)
time.sleep(60)
"""


class LockTests(unittest.TestCase):
    def test_second_instance_is_refused_and_a_killed_holder_releases(self):
        h = Harness(self)
        holder = subprocess.Popen([sys.executable, '-c', HOLD_LOCK, str(GATEWAY), str(h.config['stateFile'])],
                                  stdout=subprocess.PIPE, text=True)
        self.addCleanup(holder.stdout.close)
        self.addCleanup(holder.kill)
        self.assertEqual(holder.stdout.readline().strip(), 'LOCKED')
        class Fake(sched.Runner):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs, integrations={'NVR_RTSP_MANUAL_URI': h.checks},
                                 post=h.api, emit=lambda event: None)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(sched.main(['--config', str(h.path), '--once', '--send'], environ=ENV,
                                        runner_class=Fake), 2)
            # A resume while another executor runs would be overwritten by it.
            self.assertEqual(sched.main(['--config', str(h.path), '--resume', 'rec-1'], environ=ENV), 2)
            # Read-only commands do not need the lock.
            self.assertEqual(sched.main(['--config', str(h.path), '--validate'], environ=ENV), 0)
        self.assertIn('lock', out.getvalue())
        self.assertEqual(h.checks.calls, [])
        # Unexpected death (SIGKILL: no cleanup ran): the kernel drops the flock,
        # the leftover file is ignored and the next start just proceeds.
        holder.kill()
        holder.wait()
        self.assertTrue(Path(str(h.config['stateFile']) + '.lock').exists())
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(sched.main(['--config', str(h.path), '--once', '--send'], environ=ENV,
                                        runner_class=Fake), 0)
            # Released on return: a second in-process run is not blocked by the first.
            self.assertEqual(sched.main(['--config', str(h.path), '--once', '--send'], environ=ENV,
                                        runner_class=Fake), 0)
        self.assertEqual(len(h.checks.calls), 8)


class Silent:
    """Real TCP peer that reads and never answers; records when the client closes."""
    def __init__(self, test):
        self.server = socket.create_server(('127.0.0.1', 0))
        test.addCleanup(self.server.close)
        self.port = self.server.getsockname()[1]
        self.received, self.closed = threading.Event(), threading.Event()
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        try:
            conn, _ = self.server.accept()
            with conn:
                while conn.recv(65536):
                    self.received.set()
        except OSError:
            pass  # reset by the client, or no connection completed
        self.closed.set()


def slow_config(port, **schedule):
    config = base_config(recorders=1, timeoutSeconds=10, maxCheckSeconds=60, intervalSeconds=300, **schedule)
    config['recorders'][0]['targets'] = [{'channelNumber': 1, 'deviceId': '10000001-0000-4000-8000-000000000000',
                                          'uri': f'rtsp://127.0.0.1:{port}/{SECRET}/chID=1'}]
    return config


class RealSocketShutdownTests(unittest.TestCase):
    """Shutdown cuts live sockets: workers end well before timeoutSeconds (10 s)."""
    def start(self, config, *, real_check=True, post=None):
        h = Harness(self, config)
        if real_check:
            h.runner.integrations = sched.INTEGRATIONS
        if post:
            h.runner.post = post
        h.runner.spawn = h.runner._thread
        h.runner.tick()
        return h

    def stop(self, h):
        started = time.monotonic()
        h.runner.shutdown(5)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 1.0)
        self.assertEqual(h.of('STOPPED')[0]['stillRunning'], 0)
        return h.of('STOPPED')[0]

    def test_during_connect(self):
        polled = threading.Event()
        def unanswered(r, w, x, timeout):  # a SYN nobody answers
            polled.set()
            time.sleep(timeout)
            return [], [], []
        server = Silent(self)
        with unittest.mock.patch.object(sched, 'select', types.SimpleNamespace(select=unanswered)):
            h = self.start(slow_config(server.port))
            self.assertTrue(polled.wait(5))
            self.stop(h)
        self.assertEqual(len(h.of('CHECK_INTERRUPTED')), 1)
        self.assertEqual((h.of('CHECK'), h.api.bodies), ([], []))

    def test_during_rtsp_read(self):
        server = Silent(self)
        h = self.start(slow_config(server.port))
        self.assertTrue(server.received.wait(5))  # DESCRIBE sent, now blocked reading
        self.stop(h)
        self.assertTrue(server.closed.wait(1))
        self.assertEqual(len(h.of('CHECK_INTERRUPTED')), 1)
        self.assertEqual((h.of('CHECK'), h.api.bodies), ([], []))

    def test_during_http_delivery(self):
        server = Silent(self)
        h = Harness(self, slow_config(server.port, deliverySeconds=60))
        h.runner.api_url = f'http://127.0.0.1:{server.port}/api/v1'
        h.runner.post, h.runner.spawn = http_post, h.runner._thread
        h.runner.tick()
        self.assertTrue(server.received.wait(5))  # POST sent, now waiting for the reply
        stopped = self.stop(h)
        self.assertTrue(server.closed.wait(1))
        self.assertEqual(stopped['undeliveredRows'], 2)  # kept, never reported as stored

    def test_ctrl_c_on_the_cli_process(self):
        server = Silent(self)
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        (tmp / 'c.json').write_text(json.dumps(slow_config(server.port)))
        proc = subprocess.Popen([sys.executable, str(GATEWAY / 'stream_scheduler.py'), '--config', str(tmp / 'c.json'),
                                 '--once'], env={**os.environ, **ENV}, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
        self.addCleanup(proc.kill)
        self.assertTrue(server.received.wait(10))
        started = time.monotonic()
        proc.send_signal(signal.SIGINT)
        out, err = proc.communicate(timeout=10)
        self.assertLess(time.monotonic() - started, 2.0)
        self.assertEqual(proc.returncode, 130)
        self.assertTrue(server.closed.wait(1))
        events = [json.loads(line) for line in out.splitlines()]
        self.assertEqual([e['event'] for e in events], ['STARTED', 'CHECK_INTERRUPTED', 'STOPPED'])
        self.assertEqual(events[-1]['stillRunning'], 0)
        for value in [SECRET, USER, 'rtsp://']:
            self.assertNotIn(value, out + err)


class RealCheckTests(unittest.TestCase):
    def test_scheduler_drives_the_existing_rtsp_check(self):
        config = base_config(recorders=1)
        h = Harness(self, config)
        fixtures = {1: RtspFixture(), 2: RtspFixture(reject='DESCRIBE')}
        real = lambda t, c, b, d, v: nvr_rtsp_check.check(
            t.uri, c, b, d, binding={'deviceId': t.device_id, 'probeId': t.probe_id,
                                     'observerId': t.observer_id, 'channelNumber': t.channel_number},
            validity=v, rtsp_class=lambda *a: RtspProbe(*a, connect=lambda *x, **k: fixtures[t.channel_number]))
        h.runner.integrations = {'NVR_RTSP_MANUAL_URI': real}
        h.run_until(10, once=True)
        ok, denied = h.of('CHECK')
        self.assertEqual((ok['negotiation'], ok['media']['count']), ('SUCCEEDED', 1))
        self.assertEqual(denied['negotiation'], 'FAILED:AUTHENTICATION_FAILED')
        self.assertEqual(h.of('SUSPENDED')[0]['key'], 'recorder:rec-1')
        self.assertTrue(all(f.closed for f in fixtures.values()))
        rows = [json.loads(b) for b, _ in h.api.bodies]
        self.assertNotIn('E4_STREAM_URI_OBTAINED', {r['level'] for r in rows})
        self.assertTrue(all(r['endpoint']['access'] == 'NVR_MEDIATED' for r in rows))
        for value in [SECRET, USER, 'rtsp://', 'synthetic-session']:
            self.assertNotIn(value, json.dumps(rows) + json.dumps(h.events))


class CliTests(unittest.TestCase):
    def test_validate_and_status_do_no_network_and_print_no_secrets(self):
        h = Harness(self)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(sched.main(['--config', str(h.path), '--validate'], environ=ENV,
                                        runner_class=None), 0)
            self.assertEqual(sched.main(['--config', str(h.path), '--status'], environ=ENV,
                                        runner_class=None), 0)
            bad = dict(ENV, API_URL='http://api.example.test/api/v1')
            self.assertEqual(sched.main(['--config', str(h.path), '--validate'], environ=bad,
                                        runner_class=None), 2)
        text = out.getvalue()
        self.assertIn('CONFIG_VALID', text)
        for value in [SECRET, USER, DEVICE_KEY, 'rtsp://', 'api.example.test']:
            self.assertNotIn(value, text)

    def test_once_via_cli_exits_after_one_cycle(self):
        h = Harness(self)
        calls = []
        class Fake(sched.Runner):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs, integrations={'NVR_RTSP_MANUAL_URI': h.checks},
                                 post=h.api, emit=calls.append)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(sched.main(['--config', str(h.path), '--once', '--send'], environ=ENV,
                                        runner_class=Fake), 0)
        self.assertEqual(len([c for c in calls if c['event'] == 'CHECK']), 4)
        self.assertEqual(calls[-1]['event'], 'STOPPED')


if __name__ == '__main__':
    unittest.main()
