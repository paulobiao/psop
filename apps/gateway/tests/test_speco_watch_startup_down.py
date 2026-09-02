from __future__ import annotations

import sys
import unittest
from pathlib import Path

DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from speco_n8nrl import (  # noqa: E402
    _startup_login,
    run_watch_loop,
)

from test_speco_watch_recovery import (  # noqa: E402
    MAPPING_EMPTY,
    CapturingApi,
    FakeClient,
    reachable_result,
    scripted_collect_fn,
    unreachable_result,
)


def _loop(client, api, collect_fn, *, sleeps, max_ticks):
    return run_watch_loop(
        client,
        api,
        MAPPING_EMPTY,
        recorder_host="h",
        local_env={},
        timeout=1.0,
        credentials=("user", "pass"),
        interval=30.0,
        collect_fn=collect_fn,
        sleep_fn=lambda s: sleeps.append(s),
        log_fn=lambda *_: None,
        max_ticks=max_ticks,
    )


class StartupLoginToleranceTests(unittest.TestCase):
    def test_network_error_is_not_fatal_for_watch(self):
        """--watch iniciado com o NVR ja inacessivel nao encerra: o login
        inicial de rede falha mas e tolerado."""
        client = FakeClient(login_mode="network_error")
        outcome = _startup_login(client, "user", "pass", watch=True)
        self.assertIsNotNone(outcome)
        self.assertFalse(outcome["fatal"])
        self.assertIsNone(outcome["code"])
        self.assertNotIn("pass", str(outcome))

    def test_network_error_is_fatal_for_once(self):
        """--once/--diagnose continuam encerrando normalmente quando o
        recorder esta inacessivel."""
        client = FakeClient(login_mode="network_error")
        outcome = _startup_login(client, "user", "pass", watch=False)
        self.assertTrue(outcome["fatal"])
        self.assertEqual(outcome["code"], 6)

    def test_credential_rejection_is_fatal_even_for_watch(self):
        """Um recorder alcancavel que rejeita as credenciais e sempre fatal
        -- nao vira um login loop."""
        client = FakeClient(login_mode="auth_error")
        outcome = _startup_login(client, "user", "pass", watch=True)
        self.assertTrue(outcome["fatal"])
        self.assertEqual(outcome["code"], 5)


class WatchStartsWhileRecorderUnreachableTests(unittest.TestCase):
    def test_zero_telemetry_while_down_then_recovers_with_real_heartbeat(self):
        """watch starts while recorder unreachable
        -> zero telemetry
        -> watcher/tick permanece operacional
        -> recorder posteriormente fica reachable
        -> reauth
        -> primeira coleta real
        -> heartbeat online real volta.
        """
        api = CapturingApi()
        client = FakeClient(login_mode="network_error")  # NVR off at startup

        # 1. startup login fails but the watcher must NOT exit
        outcome = _startup_login(client, "user", "pass", watch=True)
        self.assertFalse(outcome["fatal"])

        collect_fn = scripted_collect_fn(
            [
                unreachable_result(observed=1000),  # tick 1
                unreachable_result(observed=1030),  # tick 2, first collect
                unreachable_result(observed=1060),  # tick 3, first collect
                reachable_result(observed=1065),    # tick 3, after relogin OK
            ]
        )
        sleeps: list[float] = []

        # 2. two ticks while the NVR is still down
        rc = _loop(client, api, collect_fn, sleeps=sleeps, max_ticks=2)

        self.assertEqual(rc, 0)
        # zero telemetry: no recorder heartbeat, no child observations
        self.assertEqual(api.posts, [])
        # watcher stayed operational: it slept between ticks and kept going
        self.assertEqual(sleeps, [30.0])
        # 1 startup login + exactly one controlled re-auth per unreachable
        # tick -- never an aggressive loop
        self.assertEqual(client.login_calls, 1 + 2)

        # 3. NVR comes back online
        client.login_mode = "ok"

        _loop(client, api, collect_fn, sleeps=sleeps, max_ticks=1)

        # 4. reauth happened, first real collection delivered a real
        #    ONLINE heartbeat with this tick's own timestamp
        self.assertEqual(len(api.recorder_posts), 1)
        self.assertEqual(api.recorder_posts[0]["status"], "online")
        self.assertEqual(api.recorder_posts[0]["timestamp"], 1065)

    def test_watch_loop_never_exits_on_repeated_unreachable_ticks(self):
        """O loop nao encerra por erro de rede: so KeyboardInterrupt
        (ou max_ticks, usado no teste) o para."""
        api = CapturingApi()
        client = FakeClient(login_mode="network_error")
        collect_fn = scripted_collect_fn(
            [unreachable_result(observed=1000 + i * 30) for i in range(5)]
        )
        sleeps: list[float] = []

        rc = _loop(client, api, collect_fn, sleeps=sleeps, max_ticks=5)

        self.assertEqual(rc, 0)
        self.assertEqual(api.posts, [])
        self.assertEqual(sleeps, [30.0, 30.0, 30.0, 30.0])
        self.assertEqual(client.login_calls, 5)


if __name__ == "__main__":
    unittest.main()
