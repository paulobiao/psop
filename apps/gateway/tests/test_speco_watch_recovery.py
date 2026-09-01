from __future__ import annotations

import sys
import unittest
from pathlib import Path

DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIR))

from speco_n8nrl import (
    PsopRecorderApiClient,
    SpecoError,
    SpecoLoginError,
    run_psop_once,
    watch_tick,
)

MAPPING_EMPTY = {
    "recorder": {"deviceId": "00000000-0000-4000-8000-000000000010"},
    "channels": {},
}

MAPPING_WITH_CHILD = {
    "recorder": {"deviceId": "00000000-0000-4000-8000-000000000010"},
    "channels": {
        "channel-1": {
            "deviceId": "00000000-0000-4000-8000-000000000011",
            "channelNumber": 1,
        }
    },
}


def reachable_result(*, observed: int) -> dict:
    return {
        "recorderReachable": True,
        "status": "PASSED",
        "observedAtEpoch": observed,
        "recorder": {"model": "N8NRL", "firmware": "1.0.0"},
        "poe": {"totalPowerW": 96.0, "remainingPowerW": 92.0, "ports": []},
        "storage": {"present": True, "state": "PRESENT", "disks": []},
        "channels": [],
        "onlineChannelIds": [],
        "statusSourceAvailable": True,
        "errors": [],
        "optionalGaps": [],
        "coreSourcesSucceeded": [
            "queryBasicCfg",
            "queryOnlineChlList",
            "queryDevList",
            "queryChlStatus",
            "queryRecStatus",
            "queryPoePower",
            "queryStorageDevInfo",
        ],
        "coreSourcesFailed": [],
    }


def unreachable_result(*, observed: int) -> dict:
    return {
        "recorderReachable": False,
        "status": "UNREACHABLE",
        "observedAtEpoch": observed,
        "recorder": {},
        "poe": {"totalPowerW": None, "remainingPowerW": None, "ports": []},
        "storage": {"present": None, "state": "UNKNOWN", "disks": []},
        "channels": [],
        "onlineChannelIds": None,
        "statusSourceAvailable": False,
        "errors": [
            {"source": "queryBasicCfg", "error": "SpecoError: No route to host"}
        ],
        "optionalGaps": [],
        "coreSourcesSucceeded": [],
        "coreSourcesFailed": ["queryBasicCfg"],
    }


class FakeClient:
    """Stands in for SpecoNRLClient. Only login() is exercised by watch_tick
    (collection is injected via collect_fn)."""

    def __init__(self, login_mode: str = "ok"):
        # login_mode: "ok" | "auth_error" | "network_error"
        self.login_mode = login_mode
        self.login_calls = 0
        self.session: object | None = object()

    def login(self, username: str, password: str):
        self.login_calls += 1
        if self.login_mode == "auth_error":
            self.session = None
            raise SpecoLoginError("Speco rejected the login")
        if self.login_mode == "network_error":
            raise SpecoError("reqLogin failed: No route to host")
        self.session = object()
        return self.session


class CapturingApi(PsopRecorderApiClient):
    def __init__(self):
        super().__init__("http://api.local", "rec-1", "key-1", 5.0)
        self.posts: list[tuple[str, dict]] = []

    def _post(self, path: str, payload: dict) -> dict:
        self.posts.append((path, payload))
        return {"ok": True}

    @property
    def recorder_posts(self) -> list[dict]:
        return [
            payload
            for path, payload in self.posts
            if path == "/telemetry/ingest"
        ]

    @property
    def observation_posts(self) -> list[dict]:
        return [
            payload
            for path, payload in self.posts
            if path == "/telemetry/recorder-observations"
        ]


def scripted_collect_fn(results: list[dict]):
    it = iter(results)

    def _fn(_client, **_kwargs):
        return next(it)

    return _fn


def _tick(client, api, mapping, collect_fn):
    return watch_tick(
        client,
        api,
        mapping,
        recorder_host="h",
        local_env={},
        timeout=1.0,
        credentials=("user", "pass"),
        collect_fn=collect_fn,
    )


class RunPsopOnceUnreachableTests(unittest.TestCase):
    def test_run_psop_once_skips_all_delivery_when_unreachable(self):
        """Test 4: recorderReachable=False -> send_recorder NAO chamado,
        0 child observations, SKIPPED_RECORDER_UNREACHABLE."""
        api = CapturingApi()

        delivery = run_psop_once(
            unreachable_result(observed=1000),
            api,
            MAPPING_WITH_CHILD,
        )

        self.assertEqual(api.posts, [])
        self.assertFalse(delivery["recorderDelivered"])
        self.assertEqual(
            delivery["childDelivery"], "SKIPPED_RECORDER_UNREACHABLE"
        )
        self.assertEqual(delivery["observationsSent"], 0)

    def test_send_recorder_refuses_unreachable_result(self):
        """Test 5: defesa em profundidade -- send_recorder nunca produz
        payload ONLINE para um resultado recorderReachable=False."""
        api = CapturingApi()

        with self.assertRaises(SpecoError):
            api.send_recorder({"recorderReachable": False})

        self.assertEqual(api.posts, [])

    def test_reachable_partial_collection_still_delivers_online_heartbeat(self):
        """Test 11 (regressao): recorder alcancavel + falha de enrichment
        opcional continua ONLINE / PARTIAL."""
        api = CapturingApi()

        result = reachable_result(observed=1_700_000_000)
        result["status"] = "PARTIAL"
        result["optionalGaps"] = [
            {
                "source": "cameraFirmware:channel-1",
                "error": "SpecoError: errorCode=536870962",
            }
        ]

        delivery = run_psop_once(result, api, MAPPING_EMPTY)

        self.assertTrue(delivery["recorderDelivered"])
        self.assertEqual(len(api.recorder_posts), 1)
        self.assertEqual(api.recorder_posts[0]["status"], "online")
        self.assertEqual(
            api.recorder_posts[0]["collectionState"], "PARTIAL"
        )


class WatchTickOrderingTests(unittest.TestCase):
    def test_watch_tick_delivers_this_ticks_own_collection(self):
        """Test 6: o tick coleta ANTES de entregar; o timestamp entregue e
        o da coleta do proprio tick."""
        api = CapturingApi()
        client = FakeClient()

        result, delivery = _tick(
            client,
            api,
            MAPPING_EMPTY,
            scripted_collect_fn([reachable_result(observed=1000)]),
        )

        self.assertEqual(result["observedAtEpoch"], 1000)
        self.assertEqual(len(api.recorder_posts), 1)
        self.assertEqual(api.recorder_posts[0]["timestamp"], 1000)
        self.assertEqual(api.recorder_posts[0]["status"], "online")
        self.assertTrue(delivery["recorderDelivered"])
        self.assertNotIn("reauth", delivery)

    def test_good_tick_then_unreachable_ticks_emit_one_heartbeat_only(self):
        """Test 7: good tick -> NVR cai -> proximos ticks. Somente o good
        tick gera POST; zero POSTs enquanto unreachable; timestamps nao sao
        renovados."""
        api = CapturingApi()
        client = FakeClient(login_mode="network_error")
        collect_fn = scripted_collect_fn(
            [
                reachable_result(observed=1000),
                unreachable_result(observed=1030),
                unreachable_result(observed=1060),
                unreachable_result(observed=1090),
            ]
        )

        deliveries = []
        for _ in range(4):
            _, delivery = _tick(client, api, MAPPING_EMPTY, collect_fn)
            deliveries.append(delivery)

        self.assertEqual(len(api.recorder_posts), 1)
        self.assertEqual(
            [p["timestamp"] for p in api.recorder_posts], [1000]
        )
        self.assertEqual(len(api.observation_posts), 0)

        for delivery in deliveries[1:]:
            self.assertFalse(delivery["recorderDelivered"])
            self.assertEqual(
                delivery["childDelivery"],
                "SKIPPED_RECORDER_UNREACHABLE",
            )
            self.assertEqual(delivery["reauth"], "RELOGIN_UNREACHABLE")

        # exactly one controlled re-auth per unreachable tick -- never a loop
        self.assertEqual(client.login_calls, 3)

    def test_repeated_unreachable_ticks_never_replay_last_good_result(self):
        """Test 8: ticks unreachable repetidos nao reutilizam o ultimo
        result bom."""
        api = CapturingApi()
        client = FakeClient(login_mode="network_error")
        collect_fn = scripted_collect_fn(
            [
                reachable_result(observed=1000),
                unreachable_result(observed=1030),
                unreachable_result(observed=1060),
            ]
        )

        results = []
        for _ in range(3):
            result, _ = _tick(client, api, MAPPING_EMPTY, collect_fn)
            results.append(result)

        self.assertTrue(results[0]["recorderReachable"])
        self.assertFalse(results[1]["recorderReachable"])
        self.assertFalse(results[2]["recorderReachable"])
        self.assertEqual(
            [p["timestamp"] for p in api.recorder_posts], [1000]
        )

    def test_unreachable_tick_sends_no_child_observations(self):
        """Test 10: children ficam sem assertion quando o recorder esta
        unreachable -- nenhum OFFLINE sintetico e emitido."""
        api = CapturingApi()
        client = FakeClient(login_mode="network_error")

        _, delivery = _tick(
            client,
            api,
            MAPPING_WITH_CHILD,
            scripted_collect_fn([unreachable_result(observed=1000)]),
        )

        self.assertEqual(len(api.observation_posts), 0)
        self.assertEqual(delivery["observationsSent"], 0)
        self.assertEqual(
            delivery["childDelivery"], "SKIPPED_RECORDER_UNREACHABLE"
        )


class WatchTickRecoveryTests(unittest.TestCase):
    def test_recovery_reauthenticates_once_and_resumes_real_heartbeat(self):
        """Test 9: NVR volta, sessao antiga invalida -> re-auth limitada;
        nenhuma telemetria falsa enquanto auth falha; apos auth + coleta core
        real, o heartbeat volta."""
        api = CapturingApi()
        client = FakeClient(login_mode="network_error")
        collect_fn = scripted_collect_fn(
            [
                unreachable_result(observed=1000),  # tick 1
                unreachable_result(observed=1030),  # tick 2, first collect
                reachable_result(observed=1035),    # tick 2, after relogin OK
            ]
        )

        r1, d1 = _tick(client, api, MAPPING_EMPTY, collect_fn)
        self.assertFalse(r1["recorderReachable"])
        self.assertEqual(d1["reauth"], "RELOGIN_UNREACHABLE")
        self.assertEqual(len(api.recorder_posts), 0)

        client.login_mode = "ok"  # NVR back online

        r2, d2 = _tick(client, api, MAPPING_EMPTY, collect_fn)
        self.assertEqual(d2["reauth"], "RELOGIN_OK")
        self.assertTrue(r2["recorderReachable"])
        self.assertEqual(r2["observedAtEpoch"], 1035)
        self.assertEqual(len(api.recorder_posts), 1)
        self.assertEqual(api.recorder_posts[0]["timestamp"], 1035)
        self.assertEqual(api.recorder_posts[0]["status"], "online")

        # one login attempt per unreachable tick, no aggressive loop
        self.assertEqual(client.login_calls, 2)

    def test_auth_failure_during_recovery_sends_no_telemetry(self):
        """Test 9 (variante): re-login continua falhando por AUTH -> nenhuma
        telemetria e enviada; proximo tick tenta de novo."""
        api = CapturingApi()
        client = FakeClient(login_mode="auth_error")
        collect_fn = scripted_collect_fn(
            [
                unreachable_result(observed=1000),
                unreachable_result(observed=1030),
            ]
        )

        for _ in range(2):
            _, delivery = _tick(client, api, MAPPING_EMPTY, collect_fn)
            self.assertEqual(delivery["reauth"], "RELOGIN_AUTH_FAILED")

        self.assertEqual(len(api.recorder_posts), 0)
        self.assertEqual(len(api.observation_posts), 0)
        self.assertEqual(client.login_calls, 2)


if __name__ == "__main__":
    unittest.main()
