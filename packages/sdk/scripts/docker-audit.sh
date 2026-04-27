#!/usr/bin/env bash
set -euo pipefail

SDK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${VETO_SDK_AUDIT_IMAGE:-node:20-bookworm}"

if [ "$#" -gt 0 ]; then
  TEST_ARGS="$(printf '%q ' "$@")"
else
  TEST_ARGS="tests/core/protect.test.ts tests/core/auto-apply.test.ts"
fi

docker run --rm \
  -v "${SDK_ROOT}:/src:ro" \
  -w /work \
  "${IMAGE}" \
  bash -lc "set -euo pipefail \
    && cp -a /src/. /work \
    && npm ci \
    && npm run build \
    && npm test -- ${TEST_ARGS}"
