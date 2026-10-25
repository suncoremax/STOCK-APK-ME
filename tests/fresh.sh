#!/bin/sh
su postgres -c "psql -h /tmp/pg -c 'drop database if exists bmtest' -c 'create database bmtest'" >/dev/null 2>&1
for f in schema.sql functions.sql; do su postgres -c "psql -h /tmp/pg -d bmtest -v ON_ERROR_STOP=1 -q -f /home/claude/bm/$f" 2>&1 | grep -i error; done
