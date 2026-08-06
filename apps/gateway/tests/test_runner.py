from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

DIR = Path(__file__).resolve().parents[1]
RUNNER = DIR / "run_gateway.sh"


class ManualRunnerTests(unittest.TestCase):
    def test_automatic_service_support_is_absent(self):
        self.assertFalse(
            (DIR / "install_macos_service.py").exists()
        )
        self.assertNotIn(
            "launchctl",
            RUNNER.read_text(),
        )

    def test_runner_exports_plain_device_key_assignment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner = root / "run_gateway.sh"
            gateway = root / "psop_gateway.py"
            env_file = root / ".env.local"

            runner.write_text(RUNNER.read_text())
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


if __name__ == "__main__":
    unittest.main()
