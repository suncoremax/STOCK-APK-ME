#!/bin/sh
su postgres -c "psql -h /tmp/pg -c 'drop database if exists bmtest' -c 'create database bmtest'" >/dev/null
for f in schema.sql functions.sql tests/test.sql; do
  echo "== $f"; su postgres -c "psql -h /tmp/pg -d bmtest -v ON_ERROR_STOP=1 -q -f /home/claude/bm/$f" 2>&1 | tail -${TAILN:-40}
done
