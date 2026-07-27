#!/usr/bin/env bash
set -euo pipefail

ROOT="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd
)"

cd "$ROOT"

COMPOSE_FILE="infra/docker/compose.yml"
CONTAINER="psop-postgres"
TEST_DATABASE="psop_test"

echo "=== PREPARANDO POSTGRESQL ISOLADO ==="

docker compose \
  -f "$COMPOSE_FILE" \
  up -d postgres

for attempt in $(seq 1 30); do
  if docker exec \
    "$CONTAINER" \
    pg_isready \
      -U psop \
      -d postgres \
    >/dev/null 2>&1; then
    break
  fi

  if [ "$attempt" -eq 30 ]; then
    echo "PostgreSQL não ficou disponível."
    exit 1
  fi

  sleep 1
done

DATABASE_EXISTS="$(
  docker exec \
    "$CONTAINER" \
    psql \
      -U psop \
      -d postgres \
      -tAc \
      "SELECT 1 FROM pg_database WHERE datname='${TEST_DATABASE}'"
)"

if [ "$DATABASE_EXISTS" != "1" ]; then
  docker exec \
    "$CONTAINER" \
    createdb \
      -U psop \
      -O psop \
      "$TEST_DATABASE"
fi

export NODE_ENV=test
export DATABASE_URL="postgresql://psop:psop_dev@127.0.0.1:5433/${TEST_DATABASE}?schema=public"
export JWT_SECRET="integration-access-secret-that-is-long-enough"
export JWT_REFRESH_SECRET="integration-refresh-secret-that-is-long-enough"
export JWT_EXPIRES_SECONDS=900
export JWT_REFRESH_EXPIRES_SECONDS=3600
export MFA_ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
export CONNECTIVITY_MONITOR_ENABLED=false
export AWS_REGION=us-east-1

echo
echo "=== APLICANDO MIGRATIONS NO BANCO DE TESTE ==="

pnpm --filter api exec \
  prisma migrate deploy

echo
echo "=== EXECUTANDO TESTES DE INTEGRAÇÃO ==="

pnpm --filter api \
  test:e2e

echo
echo "=== SECURITY INTEGRATION: APROVADO ==="
