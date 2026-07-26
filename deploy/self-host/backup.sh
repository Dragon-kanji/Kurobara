#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${KUROBARA_SELF_HOST_ENV_FILE:-${script_dir}/.env}"
compose=(docker compose --env-file "${env_file}" -f "${script_dir}/compose.yaml")

if [[ ! -f "${env_file}" ]]; then
  echo "Self-host environment file not found: ${env_file}" >&2
  exit 1
fi
if [[ $# -ne 1 || "${1}" != /* ]]; then
  echo "Usage: $0 /absolute/existing/backup-directory" >&2
  exit 64
fi
if [[ ! -d "${1}" ]]; then
  echo "Backup destination is not an existing directory." >&2
  exit 1
fi

umask 077
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
temporary="$(mktemp "${1}/.kurobara-${timestamp}.dump.tmp.XXXXXX")"
temporary_name="${temporary##*/}"
unique_suffix="${temporary_name##*.}"
destination="${1}/kurobara-${timestamp}-${unique_suffix}.dump"
trap 'rm -f -- "${temporary}"' EXIT

"${compose[@]}" exec -T app-postgres \
  pg_dump --format=custom --no-owner --username=kurobara kurobara \
  >"${temporary}"
mv -- "${temporary}" "${destination}"
trap - EXIT
printf '%s\n' "${destination}"
