#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

MODEL="${MODEL:-mlx-community/Qwen3.5-9B-MLX-4bit}"
PORT="${PORT:-8080}"
CORS_ORIGIN="${CORS_ORIGIN:-}"
SERVER="${PROJECT_DIR}/.venv/bin/mlx_lm.server"

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 2
}

[[ -n "${MODEL}" ]] || fail 'MODEL must not be empty'
[[ "${MODEL}" != -* ]] || fail 'MODEL must not start with -'
case "${MODEL}" in
  *$'\n'*|*$'\r'*|*$'\t'*) fail 'MODEL must not contain control whitespace' ;;
esac

[[ "${PORT}" =~ ^[0-9]+$ ]] || fail 'PORT must be an integer from 1 to 65535'
(( PORT >= 1 && PORT <= 65535 )) || fail 'PORT must be an integer from 1 to 65535'

[[ "${CORS_ORIGIN}" =~ ^chrome-extension://[a-p]{32}$ ]] || \
  fail 'CORS_ORIGIN must be chrome-extension:// followed by a 32-character extension ID'

[[ -x "${SERVER}" ]] || fail "${SERVER} is missing; create .venv and install requirements.txt first"

export HF_HUB_OFFLINE=1
export HF_HUB_DISABLE_TELEMETRY=1

exec "${SERVER}" \
  --model "${MODEL}" \
  --host 127.0.0.1 \
  --port "${PORT}" \
  --allowed-origins "${CORS_ORIGIN}" \
  --chat-template-args '{"enable_thinking":false}' \
  --decode-concurrency 1 \
  --prompt-concurrency 1 \
  --log-level CRITICAL
