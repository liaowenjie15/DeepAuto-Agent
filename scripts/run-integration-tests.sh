#!/bin/sh

set -eu

export NODE_ENV=test
export DATABASE_URL="${DATABASE_URL:-postgresql://deepauto_test:deepauto_test@127.0.0.1:5433/deepauto_test?schema=public}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6380}"

bun scripts/assert-test-environment.ts
bun run db:generate
bun run --cwd packages/db migrate:deploy
bun test tests/integration
