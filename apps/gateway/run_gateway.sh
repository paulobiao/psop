#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DIR/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  echo "Run: python3 $DIR/configure_gateway.py" >&2
  exit 1
fi

umask 077

# Export values loaded from the local environment file so the
# Python gateway process receives PSOP_DEVICE_KEY even when the
# file uses a plain KEY=value assignment.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${PSOP_DEVICE_KEY:-}" ]]; then
  echo "PSOP_DEVICE_KEY is missing from $ENV_FILE" >&2
  exit 1
fi

PYTHON_BIN="${PSOP_PYTHON:-}"

if [[ -z "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(command -v python3 || true)"
fi

if [[ -z "$PYTHON_BIN" || ! -x "$PYTHON_BIN" ]]; then
  echo "A working Python 3 executable was not found." >&2
  exit 1
fi

exec "$PYTHON_BIN" -u "$DIR/psop_gateway.py" "$@"
