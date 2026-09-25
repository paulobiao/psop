"""Offline delivery regression tests: no real API, recorder, or credentials."""
from __future__ import annotations

import copy
import io
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import unittest
import urllib.error
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import speco_n8nrl as speco
from test_speco_watch_recovery import MAPPING_WITH_CHILD, reachable_result

SECRET = 'password-device-key-Authorization-http://user:secret@host/'


def collection(observed=1):
    result = reachable_result(observed=observed)
    result['onlineChannelIds'] = ['channel-1']
    result['channels'] = [{
        'channelId': 'channel-1', 'channelNumber': 1,
        'individualVerification': 'RECORDER_VERIFIED',
        'operationalState': 'ONLINE',
    }]
    return result


def response():
    result = Mock()
    result.__enter__ = Mock(return_value=result)
    result.__exit__ = Mock(return_value=False)
    result.read.return_value = b'{}'
    return result


class DeliveryRecoveryTests(unittest.TestCase):
    def test_failures_recover_on_fresh_cycle_without_changing_health(self):
        factories = [
            lambda: urllib.error.URLError(ConnectionRefusedError(61, SECRET)),
            lambda: TimeoutError(SECRET),
            lambda: urllib.error.URLError(TimeoutError(SECRET)),
            lambda: urllib.error.HTTPError('http://user:secret@host/', 500, SECRET, {}, io.BytesIO(SECRET.encode())),
            lambda: ValueError(SECRET),  # e.g. malformed delivery response
        ]
        for factory in factories:
            for fail_child in (False, True):
                with self.subTest(error=factory, fail_child=fail_child):
                    results = [collection(1), collection(2)]
                    original = copy.deepcopy(results)
                    collect = Mock(side_effect=results)
                    recorder = Mock()
                    api = speco.PsopRecorderApiClient('http://api.invalid', 'recorder', SECRET, 0.5)
                    sleeps, logs, payloads = [], [], []
                    calls = 0

                    def post(request, **kwargs):
                        nonlocal calls
                        calls += 1
                        payloads.append(json.loads(request.data))
                        if calls == (2 if fail_child else 1):
                            raise factory()
                        return response()

                    with patch.object(speco.urllib.request, 'urlopen', side_effect=post):
                        code = speco.run_watch_loop(
                            recorder, api, MAPPING_WITH_CHILD,
                            recorder_host='recorder.invalid', local_env={}, timeout=.5,
                            credentials=('user', SECRET), interval=0,
                            collect_fn=collect, sleep_fn=sleeps.append,
                            log_fn=logs.append, max_ticks=2,
                        )
                    self.assertEqual(code, 0)
                    self.assertEqual(results, original)
                    self.assertEqual(collect.call_count, 2)
                    recorder.login.assert_not_called()
                    self.assertEqual(sleeps, [5.0])
                    self.assertIn('collection=PASSED reachable=True', logs[0])
                    self.assertIn('delivery=DELIVERY_ERROR', logs[0])
                    self.assertIn('children=unknown', logs[0])
                    self.assertIn('delivery=DELIVERED', logs[1])
                    self.assertNotIn(SECRET, '\n'.join(logs))
                    self.assertNotIn('secret@host', '\n'.join(logs))
                    for payload in payloads:
                        if 'status' in payload:
                            self.assertEqual(payload['status'], 'online')
                            self.assertEqual(payload['collectionState'], 'COMPLETE')
                        for observation in payload.get('observations', []):
                            self.assertEqual(observation['status'], 'online')
                    self.assertEqual(payloads[-1]['timestamp'], 2)

    def test_repeated_failures_wait_every_cycle_and_ctrl_c_still_stops(self):
        logs = []
        with patch.object(speco, 'run_psop_once', side_effect=RuntimeError(SECRET)):
            sleep = Mock(side_effect=[None, None, KeyboardInterrupt])
            code = speco.run_watch_loop(
                Mock(), Mock(), MAPPING_WITH_CHILD,
                recorder_host='fake', local_env={}, timeout=.5,
                credentials=('user', SECRET), interval=30,
                collect_fn=lambda *a, **kw: collection(),
                sleep_fn=sleep, log_fn=logs.append,
            )
        self.assertEqual(code, 0)
        self.assertEqual(sleep.call_count, 3)
        self.assertTrue(all(call.args == (30,) for call in sleep.call_args_list))
        self.assertEqual(sum('DELIVERY_ERROR' in line for line in logs), 3)

    def test_one_shot_still_fails(self):
        api = speco.PsopRecorderApiClient('http://api.invalid', 'rec', SECRET, .5)
        with patch.object(speco.urllib.request, 'urlopen', side_effect=TimeoutError(SECRET)):
            with self.assertRaises(speco.SpecoError) as caught:
                speco.run_psop_once(collection(), api, MAPPING_WITH_CHILD)
        self.assertNotIn(SECRET, str(caught.exception))

    def test_watch_process_alive_during_outage_and_after_recovery(self):
        # Runs main()/--watch in a real subprocess. Only external I/O is fake;
        # each stdin newline advances one normal sleep boundary deterministically.
        process = subprocess.Popen(
            [sys.executable, '-u', __file__, '--worker'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True,
        )
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        try:
            def line():
                self.assertTrue(selector.select(timeout=10), 'watcher did not produce a cycle')
                return process.stdout.readline()
            # Worker emits only cycle lines, avoiding buffered startup output.
            self.assertIn('delivery=DELIVERY_ERROR', line())
            self.assertIsNone(process.poll())
            process.stdin.write('\n')
            process.stdin.flush()
            self.assertIn('delivery=DELIVERED', line())
            self.assertIsNone(process.poll())
        finally:
            selector.close()
            process.terminate()
            process.communicate(timeout=10)


def worker():
    real_loop = speco.run_watch_loop
    requests = 0
    def post(*args, **kwargs):
        nonlocal requests
        requests += 1
        if requests == 1:
            raise urllib.error.URLError(ConnectionRefusedError(61, SECRET))
        return response()
    def loop(*args, **kwargs):
        return real_loop(*args, **kwargs,
                         collect_fn=lambda *a, **kw: collection(),
                         sleep_fn=lambda seconds: sys.stdin.readline(),
                         log_fn=lambda line: print(line, flush=True))
    env = {'PSOP_SPECO_HOST': 'fake', 'PSOP_SPECO_USERNAME': 'fake',
           'PSOP_API_URL': 'http://api.invalid', 'PSOP_SPECO_RECORDER_DEVICE_KEY': SECRET}
    with patch.object(sys, 'argv', ['speco_n8nrl.py', '--watch']), \
         patch.dict(os.environ, {'PSOP_SPECO_PASSWORD': SECRET}), \
         patch.object(speco, '_load_simple_env', return_value=env), \
         patch.object(speco, '_load_speco_map', return_value=MAPPING_WITH_CHILD), \
         patch.object(speco, 'SpecoNRLClient'), \
         patch.object(speco, '_log_line'), \
         patch.object(speco, 'run_watch_loop', side_effect=loop), \
         patch.object(speco.urllib.request, 'urlopen', side_effect=post):
        raise SystemExit(speco.main())


if __name__ == '__main__':
    if '--worker' in sys.argv:
        worker()
    else:
        unittest.main()
