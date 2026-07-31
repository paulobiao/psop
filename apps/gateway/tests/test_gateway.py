from __future__ import annotations

import json
import socket
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch

DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIR))

from psop_gateway import ApiClient, EdgeGateway, GatewayConfig, PendingStore, ProbeConfig, ProbeResult, classify, load_config, probe_tcp

class Handler(BaseHTTPRequestHandler):
    requests = []
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        self.__class__.requests.append({"path":self.path,"headers":dict(self.headers),"body":json.loads(body.decode())})
        encoded = json.dumps({"connectivity":{"state":"ONLINE"}}).encode()
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)
    def log_message(self, format, *args):
        return

class Tests(unittest.TestCase):
    def test_load_config(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "gateway.json"
            path.write_text(json.dumps({"apiUrl":"http://127.0.0.1/api/v1","deviceId":"d1","externalId":"CAM-001","target":{"host":"127.0.0.1"},"probes":[{"name":"web","type":"tcp","port":80}]}))
            config = load_config(path)
        self.assertEqual(config.device_id, "d1")
        self.assertEqual(config.probes[0].host, "127.0.0.1")

    def test_tcp_probe_success(self):
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]
        def accept_once():
            try:
                connection, _ = server.accept()
                connection.close()
            except OSError:
                pass

        thread = threading.Thread(
            target=accept_once,
            daemon=True,
        )
        thread.start()
        try:
            result = probe_tcp(ProbeConfig("tcp","tcp","127.0.0.1",port), 1)
        finally:
            server.close()
            thread.join(timeout=1)
        self.assertTrue(result.success)

    def test_classification(self):
        def item(success, required=True):
            return ProbeResult("p","tcp","localhost",80,required,success,1,"test")
        self.assertEqual(classify([item(True),item(True)]), "ONLINE")
        self.assertEqual(classify([item(True),item(False)]), "DEGRADED")
        self.assertEqual(classify([item(False),item(False)]), "OFFLINE")
        self.assertEqual(classify([item(True),item(False,False)]), "ONLINE")

    def test_store_last_write_wins(self):
        with tempfile.TemporaryDirectory() as directory:
            store = PendingStore(Path(directory) / "pending.db")
            store.save("d1", {"value":1})
            store.save("d1", {"value":2})
            self.assertEqual(store.load("d1"), {"value":2})
            store.delete("d1")
            self.assertIsNone(store.load("d1"))

    def test_api_headers(self):
        Handler.requests = []
        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = ApiClient(f"http://127.0.0.1:{server.server_port}/api/v1", "d1", "secret", 2)
            response = client.send({"timestamp":1,"status":"online"})
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)
        self.assertEqual(response["connectivity"]["state"], "ONLINE")
        headers = {k.lower():v for k,v in Handler.requests[0]["headers"].items()}
        self.assertEqual(headers["x-device-id"], "d1")
        self.assertEqual(headers["x-device-key"], "secret")

    def test_offline_withholds_and_clears_pending(self):
        with tempfile.TemporaryDirectory() as directory:
            store = PendingStore(Path(directory) / "pending.db")
            store.save("d1", {"status":"online"})
            config = GatewayConfig("http://127.0.0.1/api/v1","d1","CAM-001",30,1,None,None,Path(directory)/"pending.db",(ProbeConfig("camera","tcp","127.0.0.1",9),))
            gateway = EdgeGateway(config, None, store)
            failed = ProbeResult("camera","tcp","127.0.0.1",9,True,False,1,"refused")
            with patch("psop_gateway.run_probe", return_value=failed):
                cycle = gateway.run_cycle()
            self.assertEqual(cycle["delivery"], "WITHHELD_TARGET_OFFLINE")
            self.assertIsNone(store.load("d1"))

    def test_api_failure_buffers(self):
        class Failing:
            def send(self, payload):
                raise RuntimeError("API unavailable")
        with tempfile.TemporaryDirectory() as directory:
            store = PendingStore(Path(directory) / "pending.db")
            config = GatewayConfig("http://127.0.0.1/api/v1","d1","CAM-001",30,1,"Test",None,Path(directory)/"pending.db",(ProbeConfig("camera","tcp","127.0.0.1",80),))
            gateway = EdgeGateway(config, Failing(), store)
            success = ProbeResult("camera","tcp","127.0.0.1",80,True,True,1,"connected")
            with patch("psop_gateway.run_probe", return_value=success):
                cycle = gateway.run_cycle()
            self.assertEqual(cycle["delivery"], "BUFFERED")
            self.assertEqual(store.load("d1")["status"], "online")

if __name__ == "__main__":
    unittest.main()
