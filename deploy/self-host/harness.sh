#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${KUROBARA_SELF_HOST_ENV_FILE:-${script_dir}/.env.example}"
project_name="kurobara-smoke-${RANDOM}-$$"
backup_directory=""
backup_file=""
failed_restore_file=""
compose=(
  docker compose
  --env-file "${env_file}"
  --file "${script_dir}/compose.yaml"
  --project-name "${project_name}"
)

cleanup() {
  exit_code=$?
  if [[ "${exit_code}" -ne 0 ]]; then
    "${compose[@]}" ps >&2 || true
    "${compose[@]}" logs --no-color --tail 120 api worker >&2 || true
  fi
  "${compose[@]}" --profile tools down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [[ -n "${backup_file}" ]]; then
    rm -f -- "${backup_file}"
  fi
  if [[ -n "${failed_restore_file}" ]]; then
    rm -f -- "${failed_restore_file}"
  fi
  if [[ -n "${backup_directory}" ]]; then
    rmdir -- "${backup_directory}" >/dev/null 2>&1 || true
  fi
  return "${exit_code}"
}
trap cleanup EXIT

if ! docker info >/dev/null 2>&1; then
  echo "The Docker daemon is unavailable." >&2
  exit 1
fi

"${compose[@]}" build api worker cli
"${compose[@]}" up --detach --wait --wait-timeout 240 api worker
"${compose[@]}" --profile tools run --rm bootstrap-planning >/dev/null

credential_json="$("${compose[@]}" --profile tools run --rm bootstrap-api-key)"
api_key="$(
  CREDENTIAL_JSON="${credential_json}" node -e '
    const parsed = JSON.parse(process.env.CREDENTIAL_JSON);
    if (typeof parsed.presented_key !== "string" || parsed.presented_key.length < 32) {
      process.exit(1);
    }
    process.stdout.write(parsed.presented_key);
  '
)"
unset credential_json

run_cli() {
  KUROBARA_API_KEY="${api_key}" "${compose[@]}" --profile tools run --rm \
    --no-deps --env KUROBARA_API_KEY cli "$@"
}

run_cli dataset import \
  --endpoint http://api:3000 \
  --metadata /opt/kurobara/examples/dataset-import/metadata.json \
  --source /opt/kurobara/examples/dataset-import/source.jsonl >/dev/null
run_cli recipe apply \
  --endpoint http://api:3000 \
  --request /opt/kurobara/examples/recipe-apply/request.example.json >/dev/null
watch_json="$(
  run_cli recipe watch \
    --application-id application_demo_org_website_v1 \
    --endpoint http://api:3000 \
    --poll-interval-ms 250 \
    --timeout-ms 120000
)"
WATCH_JSON="${watch_json}" node -e '
  const result = JSON.parse(process.env.WATCH_JSON);
  if (
    result.state !== "succeeded" ||
    result.terminal !== true ||
    result.failed_cell_count !== 0
  ) {
    process.stderr.write(
      `${JSON.stringify({
        failed_cell_count: result.failed_cell_count,
        state: result.state,
        terminal: result.terminal,
      })}\n`
    );
    process.exit(1);
  }
'
unset watch_json

"${compose[@]}" stop api worker
"${compose[@]}" restart app-postgres
"${compose[@]}" up --detach --wait --wait-timeout 180 api worker
readback_json="$(
  run_cli recipe watch \
    --application-id application_demo_org_website_v1 \
    --endpoint http://api:3000 \
    --timeout-ms 0
)"
READBACK_JSON="${readback_json}" node -e '
  const result = JSON.parse(process.env.READBACK_JSON);
  if (
    result.state !== "succeeded" ||
    result.terminal !== true ||
    result.failed_cell_count !== 0
  ) {
    process.stderr.write(
      `${JSON.stringify({
        failed_cell_count: result.failed_cell_count,
        state: result.state,
        terminal: result.terminal,
      })}\n`
    );
    process.exit(1);
  }
'
unset readback_json

backup_directory="$(mktemp -d "${TMPDIR:-/tmp}/kurobara-self-host-backup.XXXXXX")"
backup_file="$(
  COMPOSE_PROJECT_NAME="${project_name}" \
    KUROBARA_SELF_HOST_ENV_FILE="${env_file}" \
    "${script_dir}/backup.sh" "${backup_directory}"
)"
failed_restore_file="$(mktemp "${backup_directory}/invalid-restore.XXXXXX.dump")"
if COMPOSE_PROJECT_NAME="${project_name}" \
  KUROBARA_SELF_HOST_ENV_FILE="${env_file}" \
  "${script_dir}/restore.sh" --confirm "${failed_restore_file}"; then
  echo "Restore unexpectedly accepted an invalid dump." >&2
  exit 1
fi
running_restore_services="$(
  "${compose[@]}" ps --services --status running api worker
)"
if [[ -n "${running_restore_services}" ]]; then
  echo \
    "Restore failure restarted application services: ${running_restore_services}" \
    >&2
  exit 1
fi
unset running_restore_services

COMPOSE_PROJECT_NAME="${project_name}" \
  KUROBARA_SELF_HOST_ENV_FILE="${env_file}" \
  "${script_dir}/restore.sh" --confirm "${backup_file}"
restored_json="$(
  run_cli recipe watch \
    --application-id application_demo_org_website_v1 \
    --endpoint http://api:3000 \
    --timeout-ms 0
)"
RESTORED_JSON="${restored_json}" node -e '
  const result = JSON.parse(process.env.RESTORED_JSON);
  if (
    result.state !== "succeeded" ||
    result.terminal !== true ||
    result.failed_cell_count !== 0
  ) {
    process.stderr.write(
      `${JSON.stringify({
        failed_cell_count: result.failed_cell_count,
        state: result.state,
        terminal: result.terminal,
      })}\n`
    );
    process.exit(1);
  }
'

unset api_key restored_json
echo "Self-host deterministic recipe smoke passed with restart and restore readback."
