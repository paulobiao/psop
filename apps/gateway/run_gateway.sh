#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DIR/.env.local"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE"
  echo "Run: python3 $DIR/configure_gateway.py"
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"
exec python3 "$DIR/psop_gateway.py" "$@"
