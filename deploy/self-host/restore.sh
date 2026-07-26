#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${KUROBARA_SELF_HOST_ENV_FILE:-${script_dir}/.env}"
compose=(docker compose --env-file "${env_file}" -f "${script_dir}/compose.yaml")

if [[ ! -f "${env_file}" ]]; then
  echo "Self-host environment file not found: ${env_file}" >&2
  exit 1
fi
if [[ $# -ne 2 || "${1}" != "--confirm" || "${2}" != /* ]]; then
  echo "Usage: $0 --confirm /absolute/path/to/kurobara.dump" >&2
  exit 64
fi
if [[ ! -f "${2}" || -L "${2}" ]]; then
  echo "Restore source must be a regular non-symlink file." >&2
  exit 1
fi

"${compose[@]}" stop api worker

if "${compose[@]}" exec -T app-postgres \
  pg_restore --clean --if-exists --no-owner --single-transaction \
    --exit-on-error --username=kurobara --dbname=kurobara <"${2}"; then
  "${compose[@]}" up --detach --wait --wait-timeout 180 api worker
else
  restore_status=$?
  echo \
    "Restore failed; api and worker remain stopped for operator inspection." \
    >&2
  exit "${restore_status}"
fi
