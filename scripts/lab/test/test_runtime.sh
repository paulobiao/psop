#!/usr/bin/env bash
#
# Unit tests for the Speco runtime-selection AND config-selection helpers
# in ../lib.sh (the two are deliberately independent — see
# docs/LAB_RUNTIME.md — so they are tested independently here too).
#
# Pure bash + temporary git repos. Never starts the lab, never touches a
# real PID, never spawns speco_n8nrl.py, never talks to the Keychain or the
# network. Safe to run at any time, including while a real watcher (e.g.
# the physical lab's PID 70582) is running elsewhere.
#
# Adapter-side behavior (how speco_n8nrl.py itself resolves
# PSOP_SPECO_CONFIG_DIR) is covered separately, in Python, by
# apps/gateway/tests/test_speco_config_dir.py (run via `pnpm test:gateway`)
# — not duplicated here.
#
# Run: bash scripts/lab/test/test_runtime.sh

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_SCRIPTS_DIR="$(cd "$HERE/.." && pwd)"

# shellcheck source=../lib.sh
source "$LAB_SCRIPTS_DIR/lib.sh"
# lib.sh sets -euo pipefail for its own safety; the test harness wants to
# keep running after a failed assertion and inspect exit codes itself.
set +e
set +u
set +o pipefail

PASS=0
FAIL=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf 'ok   - %s\n' "$desc"
    PASS=$((PASS + 1))
  else
    printf 'FAIL - %s (expected %q, got %q)\n' "$desc" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_true() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf 'ok   - %s\n' "$desc"
    PASS=$((PASS + 1))
  else
    printf 'FAIL - %s (expected success, command failed)\n' "$desc"
    FAIL=$((FAIL + 1))
  fi
}

assert_false() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf 'FAIL - %s (expected failure, command succeeded)\n' "$desc"
    FAIL=$((FAIL + 1))
  else
    printf 'ok   - %s\n' "$desc"
    PASS=$((PASS + 1))
  fi
}

# --- Sandbox -----------------------------------------------------------
#
# runtime.env lives at a fixed path derived from lib.sh's own LAB_DIR
# (this worktree's real, git-ignored .psop-lab/). We back up/restore
# whatever (if anything) was already there so this test suite never
# clobbers a developer's real local configuration.

RUNTIME_ENV_FILE="$(_lab_runtime_env_file)"
RUNTIME_ENV_BACKUP=""
if [ -f "$RUNTIME_ENV_FILE" ]; then
  RUNTIME_ENV_BACKUP="$(mktemp)"
  cp "$RUNTIME_ENV_FILE" "$RUNTIME_ENV_BACKUP"
fi

SANDBOX="$(mktemp -d)"

cleanup() {
  rm -f "$RUNTIME_ENV_FILE"
  if [ -n "$RUNTIME_ENV_BACKUP" ]; then
    mv "$RUNTIME_ENV_BACKUP" "$RUNTIME_ENV_FILE"
  fi
  # Safety net: remove any worktrees this suite registered under the
  # sandbox (see the real-commit ancestry tests below), in case an
  # earlier explicit `git worktree remove` didn't run (e.g. the suite was
  # interrupted). Never touches a worktree outside $SANDBOX.
  git worktree list --porcelain 2>/dev/null \
    | awk -v s="$SANDBOX" '$1=="worktree" && index($2,s)==1 {print $2}' \
    | while IFS= read -r wt; do
        git worktree remove --force "$wt" >/dev/null 2>&1 || true
      done
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

unset PSOP_SPECO_RUNTIME_DIR PSOP_SPECO_CONFIG_DIR 2>/dev/null

echo "PSOP lab manager — Speco runtime & config selection tests"
# Process state must not be presented as recorder reachability.
assert_eq "dead watcher reports unknown recorder health" \
  "tracked watcher pid 123 is gone; exit cause unknown (see Speco log); recorder reachability unknown" \
  "$(pid_alive() { return 1; }; speco_stopped_reason 123)"
assert_eq "reused pid is not described as gone" \
  "tracked pid 123 is alive but does not match the Speco watcher; recorder reachability unknown" \
  "$(pid_alive() { return 0; }; speco_stopped_reason 123)"

echo "--------------------------------------------------"

# ====================================================================
# PART A — runtime directory (executable code) resolution/validation
# ====================================================================

# --- A1. runtime not configured -> Speco would not start ----------------
rm -f "$RUNTIME_ENV_FILE"
unset PSOP_SPECO_RUNTIME_DIR
resolved="$(speco_runtime_dir_resolve)"
assert_eq "A1. unresolved runtime dir is empty" "" "$resolved"
check="$(speco_runtime_check "$resolved")"
assert_eq "A1. unconfigured runtime -> NOT_CONFIGURED" "NOT_CONFIGURED" "$check"

# --- A2. env var wins over runtime.env -----------------------------------
mkdir -p "$(dirname "$RUNTIME_ENV_FILE")"
printf 'PSOP_SPECO_RUNTIME_DIR=%s/from-file\n' "$SANDBOX" > "$RUNTIME_ENV_FILE"
export PSOP_SPECO_RUNTIME_DIR="$SANDBOX/from-env"
resolved="$(speco_runtime_dir_resolve)"
assert_eq "A2. env var takes precedence over runtime.env" "$SANDBOX/from-env" "$resolved"
unset PSOP_SPECO_RUNTIME_DIR

# --- A3. runtime.env works when env var is unset --------------------------
resolved="$(speco_runtime_dir_resolve)"
assert_eq "A3. runtime.env resolves when env var unset" "$SANDBOX/from-file" "$resolved"
rm -f "$RUNTIME_ENV_FILE"

# --- A4. runtime dir does not exist -> NOT_FOUND ---------------------------
check="$(speco_runtime_check "$SANDBOX/does-not-exist")"
assert_eq "A4. missing directory -> NOT_FOUND" "NOT_FOUND" "$check"

# --- A4b. runtime dir must be an absolute path ------------------------------
# A relative path's meaning would depend on the lab manager's cwd at the
# moment lab:start runs — exactly the kind of implicit resolution this
# design exists to eliminate. Applies regardless of source (env var or
# runtime.env), since the check lives in speco_runtime_check itself.
check="$(speco_runtime_check "relative/apps/gateway")"
assert_eq "A4b. relative runtime path -> NOT_ABSOLUTE" "NOT_ABSOLUTE" "$check"
check="$(speco_runtime_check "./apps/gateway")"
assert_eq "A4b. dot-relative runtime path -> NOT_ABSOLUTE" "NOT_ABSOLUTE" "$check"
check="$(speco_runtime_check "$SANDBOX/does-not-exist")"
assert_eq "A4b. an absolute (but nonexistent) runtime path proceeds past the absolute-path check to NOT_FOUND, not NOT_ABSOLUTE" \
  "NOT_FOUND" "$check"

# --- A5. speco_n8nrl.py missing -> MISSING_FILE ----------------------------
mkdir -p "$SANDBOX/no-script"
check="$(speco_runtime_check "$SANDBOX/no-script")"
assert_eq "A5. missing speco_n8nrl.py -> MISSING_FILE" "MISSING_FILE" "$check"

# --- A6. a runtime with speco_n8nrl.py but NO config passes runtime_check -
# (this is the fix for the bug found in review: runtime and config are now
# independent — a code-only runtime directory is a perfectly valid runtime,
# it is just not spawnable on its own without a valid config dir too, which
# start.sh checks separately)
REPO="$SANDBOX/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email test@example.com
git -C "$REPO" config user.name "Lab Test"
touch "$REPO/speco_n8nrl.py"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m base
commit_base="$(git -C "$REPO" rev-parse HEAD)"

echo "# fix marker" >> "$REPO/speco_n8nrl.py"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "simulated fix"
commit_fix="$(git -C "$REPO" rev-parse HEAD)"

echo "# later, legitimate change" >> "$REPO/speco_n8nrl.py"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "later"
commit_head="$(git -C "$REPO" rev-parse HEAD)"

check="$(speco_runtime_check "$REPO" "$commit_fix")"
assert_eq "A6. code-only runtime (no .env/.json inside it) still passes -> OK" "OK" "$check"

# --- A6b. ancestry against the REAL, default SPECO_MIN_RUNTIME_COMMIT,
# using actual worktrees of THIS repository checked out at the real
# commits (no synthetic history): 2ff1239 has the stale-heartbeat fix but
# predates the full runtime/config contract this lab manager depends on
# (PSOP_SPECO_CONFIG_DIR support); 0edb85a introduces that contract. This
# exercises the real default constant end-to-end, not just the mechanism.
REAL_HEARTBEAT_FIX_ONLY="2ff1239292461bba2bde2c5af7a248cbda275d05"
REAL_FULL_CONTRACT="0edb85a719469ea055c4d7e099c910ed9bf6eb32"
REAL_STALE_DIR="$SANDBOX/real-heartbeat-fix-only"
REAL_OK_DIR="$SANDBOX/real-full-contract"

if git worktree add --detach -q "$REAL_STALE_DIR" "$REAL_HEARTBEAT_FIX_ONLY" >/dev/null 2>&1; then
  check="$(speco_runtime_check "$REAL_STALE_DIR/apps/gateway")"
  assert_eq "A6b. real 2ff1239 (heartbeat fix only, no config contract) -> STALE against the real default SPECO_MIN_RUNTIME_COMMIT" \
    "STALE" "$check"
  git worktree remove --force "$REAL_STALE_DIR" >/dev/null 2>&1
else
  printf 'FAIL - A6b. could not create a detached worktree at the real 2ff1239 (is it reachable locally?)\n'
  FAIL=$((FAIL + 1))
fi

if git worktree add --detach -q "$REAL_OK_DIR" "$REAL_FULL_CONTRACT" >/dev/null 2>&1; then
  check="$(speco_runtime_check "$REAL_OK_DIR/apps/gateway")"
  assert_eq "A6b. real 0edb85a (full runtime/config contract) -> OK against the real default SPECO_MIN_RUNTIME_COMMIT" \
    "OK" "$check"
  git worktree remove --force "$REAL_OK_DIR" >/dev/null 2>&1
else
  printf 'FAIL - A6b. could not create a detached worktree at the real 0edb85a (is it reachable locally?)\n'
  FAIL=$((FAIL + 1))
fi

# --- A7. HEAD predating the min commit -> STALE ---------------------------
git -C "$REPO" checkout -q "$commit_base"
check="$(speco_runtime_check "$REPO" "$commit_fix")"
assert_eq "A7. HEAD predating min commit -> STALE" "STALE" "$check"
git -C "$REPO" checkout -q "$commit_head"

# --- A8. HEAD descending from the min commit -> OK ------------------------
check="$(speco_runtime_check "$REPO" "$commit_fix")"
assert_eq "A8. HEAD descending from min commit -> OK" "OK" "$check"

# --- A9. dirty runtime -> DIRTY --------------------------------------------
echo "local edit" >> "$REPO/speco_n8nrl.py"
check="$(speco_runtime_check "$REPO" "$commit_fix")"
assert_eq "A9. uncommitted local change -> DIRTY" "DIRTY" "$check"
git -C "$REPO" checkout -q -- speco_n8nrl.py

# --- A10. status display building blocks (head + OK message) --------------
head="$(speco_runtime_head "$REPO")"
assert_eq "A10. speco_runtime_head reads the real HEAD" "$commit_head" "$head"
msg="$(speco_runtime_check_message OK "$REPO" "$commit_fix")"
assert_eq "A10. OK message is stable/expected" "runtime OK" "$msg"
assert_true "A10. status.sh renders runtime/git HEAD/min runtime labels" \
  grep -q "git HEAD" "$LAB_SCRIPTS_DIR/status.sh"
assert_true "A10. status.sh renders a min-runtime-commit label" \
  grep -q "min runtime" "$LAB_SCRIPTS_DIR/status.sh"

# --- A11. PID/cwd mismatch -> warning ---------------------------------------
assert_true  "A11. matching cwd is recognized" \
  speco_cwd_matches "/a/b/gateway" "/a/b/gateway"
assert_true  "A11. trailing slash is normalized" \
  speco_cwd_matches "/a/b/gateway/" "/a/b/gateway"
assert_false "A11. differing cwd is NOT recognized as a match" \
  speco_cwd_matches "/a/b/gateway" "/a/other/gateway"
assert_true "A11. status.sh renders a mismatch WARNING when cwd differs" \
  grep -q "differs from the runtime recorded at start" "$LAB_SCRIPTS_DIR/status.sh"

# --- A13. stop keeps working without any runtime dir -----------------------
assert_false "A13. stop.sh has no coupling to runtime selection" \
  grep -q "RUNTIME" "$LAB_SCRIPTS_DIR/stop.sh"
(
  unset PSOP_SPECO_RUNTIME_DIR
  pid_is_ours $$ speco >/dev/null 2>&1
  true
)
assert_eq "A13. stop-path helpers tolerate an unset runtime var" "0" "$?"

# --- A14. no fallback to \$REPO_ROOT/apps/gateway ---------------------------
rm -f "$RUNTIME_ENV_FILE"
unset PSOP_SPECO_RUNTIME_DIR
resolved="$(speco_runtime_dir_resolve)"
assert_eq "A14. no configuration resolves to empty, never REPO_ROOT/apps/gateway" "" "$resolved"
if [ "$resolved" = "$REPO_ROOT/apps/gateway" ]; then
  printf 'FAIL - A14. resolved dir must never silently equal REPO_ROOT/apps/gateway\n'
  FAIL=$((FAIL + 1))
else
  printf 'ok   - %s\n' "A14. resolved dir is not REPO_ROOT/apps/gateway"
  PASS=$((PASS + 1))
fi

# ====================================================================
# PART B — config directory (.env.speco.local + speco.local.json)
# resolution/validation, independent of the runtime directory
# ====================================================================

# --- B2/B3/B4/B5. speco_config_check outcomes -------------------------------
CONFIG_OK_DIR="$SANDBOX/config-ok"
mkdir -p "$CONFIG_OK_DIR"
touch "$CONFIG_OK_DIR/.env.speco.local" "$CONFIG_OK_DIR/speco.local.json"
check="$(speco_config_check "$CONFIG_OK_DIR")"
assert_eq "B2. config dir with .env AND map -> CONFIG_OK" "CONFIG_OK" "$check"

CONFIG_NO_ENV_DIR="$SANDBOX/config-no-env"
mkdir -p "$CONFIG_NO_ENV_DIR"
touch "$CONFIG_NO_ENV_DIR/speco.local.json"
check="$(speco_config_check "$CONFIG_NO_ENV_DIR")"
assert_eq "B3. config dir without .env.speco.local -> MISSING_ENV" "MISSING_ENV" "$check"

CONFIG_NO_MAP_DIR="$SANDBOX/config-no-map"
mkdir -p "$CONFIG_NO_MAP_DIR"
touch "$CONFIG_NO_MAP_DIR/.env.speco.local"
check="$(speco_config_check "$CONFIG_NO_MAP_DIR")"
assert_eq "B4. config dir without speco.local.json -> MISSING_MAP" "MISSING_MAP" "$check"

check="$(speco_config_check "$SANDBOX/config-does-not-exist")"
assert_eq "B5. config dir does not exist -> CONFIG_NOT_FOUND" "CONFIG_NOT_FOUND" "$check"

# --- B5b. config dir must be an absolute path -------------------------------
check="$(speco_config_check "relative/config/dir")"
assert_eq "B5b. relative config path -> CONFIG_NOT_ABSOLUTE" "CONFIG_NOT_ABSOLUTE" "$check"
check="$(speco_config_check "$CONFIG_OK_DIR")"
assert_eq "B5b. the same kind of check on an absolute, valid config dir still succeeds (not CONFIG_NOT_ABSOLUTE)" \
  "CONFIG_OK" "$check"

# --- B5c. config files must be REGULAR files (-f), not just "exists" (-e) --
# A directory, or a broken symlink, with the right name must not pass; a
# symlink that resolves to a real regular file must still be accepted (-f
# follows it) — config may legitimately be a symlink to a shared file.
CONFIG_ENV_IS_DIR="$SANDBOX/config-env-is-dir"
mkdir -p "$CONFIG_ENV_IS_DIR/.env.speco.local"
touch "$CONFIG_ENV_IS_DIR/speco.local.json"
check="$(speco_config_check "$CONFIG_ENV_IS_DIR")"
assert_eq "B5c. .env.speco.local is a directory -> MISSING_ENV" "MISSING_ENV" "$check"

CONFIG_MAP_IS_DIR="$SANDBOX/config-map-is-dir"
mkdir -p "$CONFIG_MAP_IS_DIR/speco.local.json"
touch "$CONFIG_MAP_IS_DIR/.env.speco.local"
check="$(speco_config_check "$CONFIG_MAP_IS_DIR")"
assert_eq "B5c. speco.local.json is a directory -> MISSING_MAP" "MISSING_MAP" "$check"

CONFIG_BROKEN_SYMLINK="$SANDBOX/config-broken-symlink"
mkdir -p "$CONFIG_BROKEN_SYMLINK"
ln -s "$SANDBOX/this-target-does-not-exist" "$CONFIG_BROKEN_SYMLINK/.env.speco.local"
touch "$CONFIG_BROKEN_SYMLINK/speco.local.json"
check="$(speco_config_check "$CONFIG_BROKEN_SYMLINK")"
assert_eq "B5c. .env.speco.local is a broken symlink -> MISSING_ENV" "MISSING_ENV" "$check"

CONFIG_VALID_SYMLINK="$SANDBOX/config-valid-symlink"
mkdir -p "$CONFIG_VALID_SYMLINK"
REAL_ENV_FILE="$SANDBOX/real-env-file-target"
printf 'PSOP_SPECO_HOST=example.invalid\n' > "$REAL_ENV_FILE"
ln -s "$REAL_ENV_FILE" "$CONFIG_VALID_SYMLINK/.env.speco.local"
touch "$CONFIG_VALID_SYMLINK/speco.local.json"
check="$(speco_config_check "$CONFIG_VALID_SYMLINK")"
assert_eq "B5c. a symlink resolving to a real regular file -> CONFIG_OK" "CONFIG_OK" "$check"

# --- B6. PSOP_SPECO_CONFIG_DIR env var wins over runtime.env ----------------
printf 'PSOP_SPECO_CONFIG_DIR=%s/config-from-file\n' "$SANDBOX" > "$RUNTIME_ENV_FILE"
export PSOP_SPECO_CONFIG_DIR="$SANDBOX/config-from-env"
resolved="$(speco_config_dir_resolve)"
assert_eq "B6. config env var takes precedence over runtime.env" "$SANDBOX/config-from-env" "$resolved"
unset PSOP_SPECO_CONFIG_DIR

# --- B7. runtime.env PSOP_SPECO_CONFIG_DIR works when env var is unset ------
resolved="$(speco_config_dir_resolve)"
assert_eq "B7. config runtime.env resolves when env var unset" "$SANDBOX/config-from-file" "$resolved"
rm -f "$RUNTIME_ENV_FILE"

# --- B7b. (bonus) config dir has a safe default, unlike runtime dir --------
resolved="$(speco_config_dir_resolve)"
assert_eq "B7b. config dir defaults to REPO_ROOT/apps/gateway (not fail-closed)" \
  "$REPO_ROOT/apps/gateway" "$resolved"

# --- B11. no secret reaches an output function ------------------------------
# (PSOP_SPECO_CONFIG_DIR is not a secret and is expected to appear in `log`
# lines; only PSOP_SPECO_PASSWORD must never reach an output function.)
secret_leak=0
for f in "$LAB_SCRIPTS_DIR/lib.sh" "$LAB_SCRIPTS_DIR/start.sh" "$LAB_SCRIPTS_DIR/status.sh"; do
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      *export\ PSOP_SPECO_PASSWORD*|*unset*PSOP_SPECO_PASSWORD*|'#'*) continue ;;
    esac
    case "$line" in
      *printf*|*echo*|*log\ *|*warn\ *|*err\ *|*detail\ *|*row\ *)
        secret_leak=1
        printf 'FAIL - B11. possible secret output in %s: %s\n' "$f" "$line"
        ;;
    esac
  done < <(grep -n "PSOP_SPECO_PASSWORD" "$f" | cut -d: -f2-)
done
if [ "$secret_leak" -eq 0 ]; then
  printf 'ok   - %s\n' "B11. no PSOP_SPECO_PASSWORD reaches an output function in lib.sh/start.sh/status.sh"
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
fi
assert_false "B11. .env.speco.local contents are never read/echoed by config_check" \
  grep -qE "cat .*\.env\.speco\.local|echo .*\\\$\(.*\.env\.speco\.local" "$LAB_SCRIPTS_DIR/lib.sh"

# --- B12. spawn uses the runtime dir as cwd, passed as a positional arg,
#          not interpolated into the bash -c string --------------------------
assert_true "B12. spawn cd's into the runtime dir via a positional argument (\$1), not string interpolation" \
  grep -q 'cd "\$1"' "$LAB_SCRIPTS_DIR/start.sh"
assert_false "B12. the old unsafe interpolated form is gone" \
  grep -q "cd '\$SPECO_RUNTIME_DIR'" "$LAB_SCRIPTS_DIR/start.sh"
assert_true "B12. PSOP_SPECO_CONFIG_DIR is exported to the spawned child" \
  grep -q 'export PSOP_SPECO_CONFIG_DIR=' "$LAB_SCRIPTS_DIR/start.sh"
assert_true "B12. PSOP_SPECO_CONFIG_DIR is unset in the parent shell after spawn" \
  grep -q 'unset PSOP_SPECO_PASSWORD PSOP_SPECO_CONFIG_DIR' "$LAB_SCRIPTS_DIR/start.sh"

# --- B13. status.sh distinguishes runtime from config -----------------------
assert_true "B13. status.sh has a distinct \"config\" label" \
  grep -q '"config ' "$LAB_SCRIPTS_DIR/status.sh"
assert_true "B13. status.sh calls speco_config_check independently of speco_runtime_check" \
  grep -q "speco_config_check" "$LAB_SCRIPTS_DIR/status.sh"

# --- B14/B15. already covered by A9 (DIRTY) and A7 (STALE) — the runtime
# guards are unchanged by this config-separation fix, only what they check
# (code only, not config) changed. Re-asserted here for direct traceability
# against the "testes obrigatórios" list.
assert_eq "B14. runtime dirty is still blocked (same as A9)" "DIRTY" \
  "$(echo "local edit" >> "$REPO/speco_n8nrl.py"; speco_runtime_check "$REPO" "$commit_fix")"
git -C "$REPO" checkout -q -- speco_n8nrl.py
git -C "$REPO" checkout -q "$commit_base"
assert_eq "B15. runtime stale is still blocked (same as A7)" "STALE" \
  "$(speco_runtime_check "$REPO" "$commit_fix")"
git -C "$REPO" checkout -q "$commit_head"

echo "--------------------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
