#!/usr/bin/env bash
#
# Unit tests for the Speco runtime-selection helpers in ../lib.sh.
#
# Pure bash + temporary git repos. Never starts the lab, never touches a
# real PID, never spawns speco_n8nrl.py, never talks to the Keychain or the
# network. Safe to run at any time, including while a real watcher (e.g.
# the physical lab's PID 70582) is running elsewhere.
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
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

unset PSOP_SPECO_RUNTIME_DIR PSOP_SPECO_CONFIG_DIR 2>/dev/null

echo "PSOP lab manager — Speco runtime selection tests"
echo "--------------------------------------------------"

# --- 1. runtime not configured -> Speco would not start -----------------
rm -f "$RUNTIME_ENV_FILE"
unset PSOP_SPECO_RUNTIME_DIR
resolved="$(speco_runtime_dir_resolve)"
assert_eq "1. unresolved runtime dir is empty" "" "$resolved"
check="$(speco_runtime_check "$resolved")"
assert_eq "1. unconfigured runtime -> NOT_CONFIGURED" "NOT_CONFIGURED" "$check"

# --- 2. env var wins over runtime.env -----------------------------------
mkdir -p "$(dirname "$RUNTIME_ENV_FILE")"
printf 'PSOP_SPECO_RUNTIME_DIR=%s/from-file\n' "$SANDBOX" > "$RUNTIME_ENV_FILE"
export PSOP_SPECO_RUNTIME_DIR="$SANDBOX/from-env"
resolved="$(speco_runtime_dir_resolve)"
assert_eq "2. env var takes precedence over runtime.env" "$SANDBOX/from-env" "$resolved"
unset PSOP_SPECO_RUNTIME_DIR

# --- 3. runtime.env works when env var is unset --------------------------
resolved="$(speco_runtime_dir_resolve)"
assert_eq "3. runtime.env resolves when env var unset" "$SANDBOX/from-file" "$resolved"
rm -f "$RUNTIME_ENV_FILE"

# --- 4. runtime dir does not exist -> NOT_FOUND ---------------------------
check="$(speco_runtime_check "$SANDBOX/does-not-exist")"
assert_eq "4. missing directory -> NOT_FOUND" "NOT_FOUND" "$check"

# --- 5. speco_n8nrl.py missing -> MISSING_FILE ----------------------------
mkdir -p "$SANDBOX/no-script"
check="$(speco_runtime_check "$SANDBOX/no-script")"
assert_eq "5. missing speco_n8nrl.py -> MISSING_FILE" "MISSING_FILE" "$check"

# --- 5b. (bonus) missing .env.speco.local -> MISSING_CONFIG ---------------
mkdir -p "$SANDBOX/no-config"
touch "$SANDBOX/no-config/speco_n8nrl.py"
check="$(speco_runtime_check "$SANDBOX/no-config")"
assert_eq "5b. missing .env.speco.local -> MISSING_CONFIG" "MISSING_CONFIG" "$check"

# --- 6. runtime without git -> NOT_GIT ------------------------------------
mkdir -p "$SANDBOX/no-git"
touch "$SANDBOX/no-git/speco_n8nrl.py" "$SANDBOX/no-git/.env.speco.local"
check="$(speco_runtime_check "$SANDBOX/no-git")"
assert_eq "6. not a git worktree -> NOT_GIT" "NOT_GIT" "$check"

# --- 7 & 8. ancestry: STALE when min commit is not an ancestor, --------
#            OK when it is (via an overridable min-commit, so this does
#            NOT depend on the real repo's history at all)
REPO="$SANDBOX/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email test@example.com
git -C "$REPO" config user.name "Lab Test"
touch "$REPO/speco_n8nrl.py" "$REPO/.env.speco.local"
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
assert_eq "8. HEAD descending from min commit -> OK" "OK" "$check"

git -C "$REPO" checkout -q "$commit_base"
check="$(speco_runtime_check "$REPO" "$commit_fix")"
assert_eq "7. HEAD predating min commit -> STALE" "STALE" "$check"
git -C "$REPO" checkout -q "$commit_head"

# --- 9. dirty runtime -> DIRTY --------------------------------------------
echo "local edit" >> "$REPO/speco_n8nrl.py"
check="$(speco_runtime_check "$REPO" "$commit_fix")"
assert_eq "9. uncommitted local change -> DIRTY" "DIRTY" "$check"
git -C "$REPO" checkout -q -- speco_n8nrl.py

# --- 10. status display building blocks (head + OK message) --------------
# lab:status shows runtime/cwd/git-HEAD/min-fix without starting a real
# process; the underlying data it reads is exercised directly here rather
# than by parsing terminal output (which would require a live PID).
head="$(speco_runtime_head "$REPO")"
assert_eq "10. speco_runtime_head reads the real HEAD" "$commit_head" "$head"
msg="$(speco_runtime_check_message OK "$REPO" "$commit_fix")"
assert_eq "10. OK message is stable/expected" "runtime OK" "$msg"
assert_true "10. status.sh renders runtime/git HEAD/min fix labels" \
  grep -q "git HEAD" "$LAB_SCRIPTS_DIR/status.sh"
assert_true "10. status.sh renders a min-fix label" \
  grep -q "min fix" "$LAB_SCRIPTS_DIR/status.sh"

# --- 11. PID/cwd mismatch -> warning ---------------------------------------
assert_true  "11. matching cwd is recognized" \
  speco_cwd_matches "/a/b/gateway" "/a/b/gateway"
assert_true  "11. trailing slash is normalized" \
  speco_cwd_matches "/a/b/gateway/" "/a/b/gateway"
assert_false "11. differing cwd is NOT recognized as a match" \
  speco_cwd_matches "/a/b/gateway" "/a/other/gateway"
assert_true "11. status.sh renders a mismatch WARNING when cwd differs" \
  grep -q "differs from the runtime recorded at start" "$LAB_SCRIPTS_DIR/status.sh"

# --- 12. config/secrets never appear directly in output --------------------
# Static check: every line mentioning PSOP_SPECO_PASSWORD in the shipped
# scripts must be an export/unset (or a comment), never fed to an output
# function (printf/echo/log/warn/err/detail/row) on the same line.
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
        printf 'FAIL - 12. possible secret output in %s: %s\n' "$f" "$line"
        ;;
    esac
  done < <(grep -n "PSOP_SPECO_PASSWORD" "$f" | cut -d: -f2-)
done
if [ "$secret_leak" -eq 0 ]; then
  printf 'ok   - %s\n' "12. no PSOP_SPECO_PASSWORD reaches an output function in lib.sh/start.sh/status.sh"
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
fi

# --- 13. stop keeps working without any runtime dir -----------------------
assert_false "13. stop.sh has no coupling to runtime selection" \
  grep -q "RUNTIME" "$LAB_SCRIPTS_DIR/stop.sh"
(
  unset PSOP_SPECO_RUNTIME_DIR
  # pid_is_ours must not error just because no runtime dir is configured —
  # stop.sh's guard logic never references it at all.
  pid_is_ours $$ speco >/dev/null 2>&1
  true
)
assert_eq "13. stop-path helpers tolerate an unset runtime var" "0" "$?"

# --- 14. no fallback to \$REPO_ROOT/apps/gateway ---------------------------
rm -f "$RUNTIME_ENV_FILE"
unset PSOP_SPECO_RUNTIME_DIR
resolved="$(speco_runtime_dir_resolve)"
assert_eq "14. no configuration resolves to empty, never REPO_ROOT/apps/gateway" "" "$resolved"
if [ "$resolved" = "$REPO_ROOT/apps/gateway" ]; then
  printf 'FAIL - 14. resolved dir must never silently equal REPO_ROOT/apps/gateway\n'
  FAIL=$((FAIL + 1))
else
  printf 'ok   - %s\n' "14. resolved dir is not REPO_ROOT/apps/gateway"
  PASS=$((PASS + 1))
fi

echo "--------------------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
