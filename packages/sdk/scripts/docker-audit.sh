#!/usr/bin/env bash
set -euo pipefail

SDK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SDK_ROOT}/../.." && pwd)"
IMAGE="${VETO_SDK_AUDIT_IMAGE:-node:20-bookworm}"
ENTRYPOINT="${VETO_SDK_AUDIT_ENTRYPOINT:-}"
SHELL_BIN="${VETO_SDK_AUDIT_SHELL:-bash}"
DOCKER_RUN_ARGS=()
CONTAINER_SHELL_ARGS=("${SHELL_BIN}" "-lc")

if [ -n "${ENTRYPOINT}" ]; then
  DOCKER_RUN_ARGS+=(--entrypoint "${ENTRYPOINT}")
  CONTAINER_SHELL_ARGS=("-lc")
fi

if [ "$#" -gt 0 ]; then
  case "$1" in
    cli)
      TEST_ARGS="tests/cli/*.test.ts tests/compiler/*.test.ts tests/rules/*.test.ts tests/policy/generator.test.ts tests/testing/runner.test.ts"
      ;;
    core)
      TEST_ARGS="tests/core/protect.test.ts tests/core/auto-apply.test.ts tests/core/veto.test.ts tests/cloud/client.test.ts tests/cloud/policy-cache.test.ts"
      ;;
    integrations)
      TEST_ARGS="tests/admin/client.test.ts tests/integrations/*.test.ts src/browser/__tests__/*.test.ts"
      ;;
    runtime)
      TEST_ARGS="tests/proxy/*.test.ts tests/benchmark/*.test.ts tests/observability/*.test.ts"
      ;;
    feature-audit|all)
      TEST_ARGS="tests/admin/client.test.ts tests/benchmark/*.test.ts tests/cli/*.test.ts tests/compiler/*.test.ts tests/core/*.test.ts tests/cloud/*.test.ts tests/economic/*.test.ts tests/integrations/*.test.ts tests/kernel/*.test.ts tests/observability/*.test.ts tests/policy/*.test.ts tests/proxy/*.test.ts tests/providers/*.test.ts tests/rate-limiting/*.test.ts tests/rules/*.test.ts tests/testing/*.test.ts src/browser/__tests__/*.test.ts"
      ;;
    *)
      TEST_ARGS="$(printf '%q ' "$@")"
      ;;
  esac
else
  TEST_ARGS="tests/core/protect.test.ts tests/core/auto-apply.test.ts"
fi

docker run --rm \
  -v "${REPO_ROOT}:/repo:ro" \
  -w /work/packages/sdk \
  "${DOCKER_RUN_ARGS[@]}" \
  "${IMAGE}" \
  "${CONTAINER_SHELL_ARGS[@]}" "set -euo pipefail \
    && if ! command -v git >/dev/null 2>&1; then \
      if command -v apk >/dev/null 2>&1; then \
        apk add --no-cache git >/dev/null; \
      elif command -v apt-get >/dev/null 2>&1; then \
        apt-get update >/dev/null && apt-get install -y git >/dev/null; \
      elif command -v microdnf >/dev/null 2>&1; then \
        microdnf install -y git >/dev/null; \
      else \
        echo 'git is required for CLI diff tests, but no supported package manager is available in the audit image.' >&2; \
        exit 1; \
      fi; \
    fi \
    && mkdir -p /work/packages/sdk \
    && cp -a /repo/packages/sdk/. /work/packages/sdk \
    && if [ -d /repo/conformance ]; then cp -a /repo/conformance /work/conformance; fi \
    && npm ci --include=dev --fetch-retries=5 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=10000 \
    && npm run build \
    && npm test -- ${TEST_ARGS}"
