#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${KUROBARA_SELF_HOST_ENV_FILE:-${script_dir}/.env.example}"
project_name="kurobara-smoke-${RANDOM}-$$"
backup_directory=""
backup_file=""
failed_restore_file=""
stage="preflight"
compose=(
  docker compose
  --env-file "${env_file}"
  --file "${script_dir}/compose.yaml"
  --project-name "${project_name}"
)

cleanup() {
  exit_code=$?
  if [[ "${exit_code}" -ne 0 ]]; then
    STAGE="${stage}" node -e '
      process.stderr.write(
        `${JSON.stringify({
          ok: false,
          schema_version: "1.0.0",
          stage: process.env.STAGE,
        })}\n`
      );
    ' || true
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

stage="build"
"${compose[@]}" build api worker cli
stage="runtime_start"
"${compose[@]}" up --detach --wait --wait-timeout 240 api worker
stage="planning_bootstrap"
"${compose[@]}" --profile tools run --rm bootstrap-planning >/dev/null

stage="client_credential_bootstrap"
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

stage="dataset_import"
run_cli dataset import \
  --endpoint http://api:3000 \
  --metadata /opt/kurobara/examples/dataset-import/metadata.json \
  --source /opt/kurobara/examples/dataset-import/source.jsonl >/dev/null
stage="recipe_apply"
run_cli recipe apply \
  --endpoint http://api:3000 \
  --request /opt/kurobara/examples/recipe-apply/request.example.json >/dev/null
stage="recipe_watch"
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

stage="restart_readback"
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

stage="backup"
backup_directory="$(mktemp -d "${TMPDIR:-/tmp}/kurobara-self-host-backup.XXXXXX")"
backup_file="$(
  COMPOSE_PROJECT_NAME="${project_name}" \
    KUROBARA_SELF_HOST_ENV_FILE="${env_file}" \
    "${script_dir}/backup.sh" "${backup_directory}"
)"
failed_restore_file="$(mktemp "${backup_directory}/invalid-restore.XXXXXX.dump")"
stage="invalid_restore_guard"
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

stage="restore"
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

stage="dataset_export"
export_json="$(
  run_cli dataset export \
    --dataset-id dataset_demo_orgs \
    --endpoint http://api:3000 \
    --format jsonl \
    --output /tmp/kurobara-first-run.jsonl \
    --timeout-ms 120000
)"
FIRST_RUN_EXPORT_JSON="${export_json}" node -e '
  const exported = JSON.parse(process.env.FIRST_RUN_EXPORT_JSON);
  if (
    exported.dataset_id !== "dataset_demo_orgs" ||
    exported.format !== "jsonl" ||
    !(Number.isSafeInteger(exported.byte_count) && exported.byte_count > 0) ||
    typeof exported.sha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(exported.sha256)
  ) {
    process.exit(1);
  }
'

stage="complete"
FIRST_RUN_EXPORT_JSON="${export_json}" node -e '
  const exported = JSON.parse(process.env.FIRST_RUN_EXPORT_JSON);
  process.stdout.write(
    `${JSON.stringify({
      application_id: "application_demo_org_website_v1",
      dataset_id: "dataset_demo_orgs",
      export: {
        byte_count: exported.byte_count,
        format: exported.format,
        retained: false,
        sha256: exported.sha256,
      },
      ok: true,
      schema_version: "1.0.0",
    })}\n`
  );
'

unset api_key export_json restored_json
