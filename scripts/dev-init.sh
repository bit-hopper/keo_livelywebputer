#!/usr/bin/env bash
# One-shot local dev bring-up: makes sure Postgres and (if configured)
# Redis are actually running, loads DATABASE_URL/REDIS_URL/etc from
# .env.local (never committed -- copy .env.local.example to .env.local
# and fill in real values first), then execs bin/lk-server.js.
#
# lk-server.js is purely a client of both -- it never starts or manages
# either process itself (see postgres-client.js/redis-client.js). This
# script exists because WSL has no systemd, so neither service survives a
# `wsl --shutdown`/reboot on its own; something has to check/start them
# before the app can use them.
#
# Usage: ./scripts/dev-init.sh [extra lk-server flags...]
#   e.g. ./scripts/dev-init.sh --no-partsbin-check
set -e

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -f .env.local ]; then
  echo "No .env.local found -- copy .env.local.example to .env.local and set a real DATABASE_URL first." >&2
  exit 1
fi
set -a
source .env.local
set +a

if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is not set in .env.local -- required, no SQLite fallback exists anymore." >&2
  exit 1
fi

# --- Postgres ---
if ! pg_isready -q; then
  echo "Postgres is not running -- starting it (needs sudo)..."
  sudo service postgresql start
  for i in $(seq 1 10); do
    pg_isready -q && break
    sleep 1
  done
fi
if ! pg_isready -q; then
  echo "Postgres still not accepting connections after a start attempt." >&2
  exit 1
fi
echo "Postgres: up"

# --- Redis (optional -- only the realtime backplane needs it; unset
# REDIS_URL is a supported single-process-in-memory mode, not an error) ---
if [ -n "$REDIS_URL" ]; then
  REDIS_PORT=$(node -e "try{console.log(new URL(process.env.REDIS_URL).port||6379)}catch(e){console.log(6379)}")
  if ! redis-cli -p "$REDIS_PORT" ping > /dev/null 2>&1; then
    echo "Redis is not running on port $REDIS_PORT -- starting it..."
    redis-server --port "$REDIS_PORT" --daemonize yes
    for i in $(seq 1 10); do
      redis-cli -p "$REDIS_PORT" ping > /dev/null 2>&1 && break
      sleep 1
    done
  fi
  if ! redis-cli -p "$REDIS_PORT" ping > /dev/null 2>&1; then
    echo "Redis still not responding on port $REDIS_PORT after a start attempt." >&2
    exit 1
  fi
  echo "Redis: up (port $REDIS_PORT)"
else
  echo "REDIS_URL not set -- skipping Redis (SessionTracker/RoomSignaling/LiveDocSync run single-process in-memory)."
fi

# --- App server ---
PORT=${PORT:-9001}
WORKERS=${WORKERS:-2}
echo "Starting lk-server on port $PORT with $WORKERS worker(s)..."
exec node bin/lk-server.js --port "$PORT" --workers "$WORKERS" "$@"
