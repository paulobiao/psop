#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ] && [ -n "${DB_HOST:-}" ]; then
  export DATABASE_URL="$(
    node <<'NODE'
const required = [
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD",
];

for (const name of required) {
  if (!process.env[name]) {
    console.error(`Missing required database variable: ${name}`);
    process.exit(1);
  }
}

const user = encodeURIComponent(process.env.DB_USER);
const password = encodeURIComponent(process.env.DB_PASSWORD);
const host = process.env.DB_HOST;
const port = process.env.DB_PORT;
const database = encodeURIComponent(process.env.DB_NAME);

process.stdout.write(
  `postgresql://${user}:${password}@${host}:${port}/${database}?schema=public&sslmode=require`
);
NODE
  )"
fi

exec "$@"
