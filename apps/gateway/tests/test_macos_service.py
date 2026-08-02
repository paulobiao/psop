from __future__ import annotations

import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIR))

from install_macos_service import (
    LABEL,
    build_plist,
    has_device_key,
    parse_service_details,
)


class MacosServiceTests(unittest.TestCase):
    def test_plist_uses_runner_without_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "gateway.json"
            runner = root / "run_gateway.sh"
            stdout = root / "stdout.log"
            stderr = root / "stderr.log"

            config.write_text("{}")
            runner.write_text("#!/bin/bash\n")

            payload = build_plist(
                config,
                python_path=Path("/usr/bin/python3"),
                root=root,
                runner=runner,
                stdout_path=stdout,
                stderr_path=stderr,
            )

            serialized = plistlib.dumps(payload).decode()

        self.assertEqual(payload["Label"], LABEL)
        self.assertEqual(
            payload["ProgramArguments"],
            [
                "/bin/bash",
                str(runner.resolve()),
                "--config",
                str(config.resolve()),
            ],
        )
        self.assertNotIn("PSOP_DEVICE_KEY", serialized)
        self.assertTrue(payload["RunAtLoad"])
        self.assertEqual(
            payload["KeepAlive"],
            {"SuccessfulExit": False},
        )

    def test_device_key_detection_does_not_return_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env.local"

            path.write_text(
                "export PSOP_DEVICE_KEY='test-secret'\n"
            )

            self.assertTrue(has_device_key(path))

            path.write_text("PSOP_DEVICE_KEY=\n")

            self.assertFalse(has_device_key(path))

    def test_runner_exports_plain_device_key_assignment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner = root / "run_gateway.sh"
            gateway = root / "psop_gateway.py"
            env_file = root / ".env.local"

            source_runner = DIR / "run_gateway.sh"
            runner.write_text(source_runner.read_text())
            runner.chmod(0o755)

            env_file.write_text(
                "PSOP_DEVICE_KEY=test-device-key\n"
            )

            gateway.write_text(
                "import os\n"
                "print(os.environ.get('PSOP_DEVICE_KEY', ''))\n"
            )

            result = subprocess.run(
                ["/bin/bash", str(runner)],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env={
                    **os.environ,
                    "PSOP_PYTHON": sys.executable,
                },
            )

        self.assertEqual(
            result.returncode,
            0,
            result.stderr,
        )
        self.assertEqual(
            result.stdout.strip(),
            "test-device-key",
        )

    def test_service_detail_parser(self):
        details = parse_service_details(
            '''
            state = running
            pid = 4242
            last exit code = 0
            '''
        )

        self.assertEqual(details["state"], "running")
        self.assertEqual(details["pid"], "4242")
        self.assertEqual(details["lastExitStatus"], "0")


if __name__ == "__main__":
    unittest.main()
