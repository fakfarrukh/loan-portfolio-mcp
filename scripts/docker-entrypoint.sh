#!/bin/sh
set -eu
# Seed the synthetic database on first start (the data volume is empty).
if [ ! -f "$DB_PATH" ]; then
  echo "No database at $DB_PATH; generating synthetic portfolio..." >&2
  node dist/db/seed-cli.js
fi
exec node dist/index.js "$@"
