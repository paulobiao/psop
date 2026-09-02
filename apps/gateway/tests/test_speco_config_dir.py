from __future__ import annotations

import sys
import unittest
from pathlib import Path

DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIR))

from speco_n8nrl import CONFIG_DIR, DEFAULT_LOCAL_ENV, DEFAULT_LOCAL_MAP, LOCAL_DIR, resolve_speco_config_dir


class SpecoConfigDirTests(unittest.TestCase):
    """PSOP_SPECO_CONFIG_DIR decouples where speco_n8nrl.py's local config
    (.env.speco.local, speco.local.json) is read from, from where the script
    itself lives (LOCAL_DIR) — so a lab runtime directory can be code-only.

    resolve_speco_config_dir() takes an explicit `env` dict rather than
    reading the real process environment, so these tests never need to
    mutate os.environ or reload the module (reloading it would break class
    identity — SpecoError et al. — for every other test module that already
    imported speco_n8nrl in this same unittest-discover process).
    """

    def test_without_env_var_resolves_to_local_dir(self):
        self.assertEqual(resolve_speco_config_dir(LOCAL_DIR, env={}), LOCAL_DIR)

    def test_env_var_overrides_local_dir(self):
        config_dir = Path("/tmp/psop-test-speco-config-dir-does-not-need-to-exist")
        resolved = resolve_speco_config_dir(
            LOCAL_DIR, env={"PSOP_SPECO_CONFIG_DIR": str(config_dir)}
        )
        self.assertEqual(resolved, config_dir)

    def test_env_var_supports_user_home_expansion(self):
        resolved = resolve_speco_config_dir(LOCAL_DIR, env={"PSOP_SPECO_CONFIG_DIR": "~"})
        self.assertEqual(resolved, Path.home())

    def test_module_level_config_dir_matches_local_dir_by_default(self):
        # This process was imported without PSOP_SPECO_CONFIG_DIR set (the
        # test runner does not set it), so the module-level constants must
        # reflect the standalone, next-to-the-script default.
        self.assertEqual(CONFIG_DIR, LOCAL_DIR)
        self.assertEqual(DEFAULT_LOCAL_ENV, LOCAL_DIR / ".env.speco.local")
        self.assertEqual(DEFAULT_LOCAL_MAP, LOCAL_DIR / "speco.local.json")

    def test_env_file_and_map_file_both_move_with_config_dir(self):
        config_dir = Path("/tmp/psop-test-speco-config-dir-does-not-need-to-exist")
        env_path = config_dir / ".env.speco.local"
        map_path = config_dir / "speco.local.json"
        resolved = resolve_speco_config_dir(
            LOCAL_DIR, env={"PSOP_SPECO_CONFIG_DIR": str(config_dir)}
        )
        self.assertEqual(resolved / ".env.speco.local", env_path)
        self.assertEqual(resolved / "speco.local.json", map_path)


if __name__ == "__main__":
    unittest.main()
