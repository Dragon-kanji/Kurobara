#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
env_file="${KUROBARA_HATCHET_ENV_FILE:-${script_dir}/.env.example}"
compose_file="${script_dir}/compose.yaml"

if [[ ! -f "${env_file}" ]]; then
  echo "Hatchet environment file not found: ${env_file}" >&2
  exit 1
fi

compose=(docker compose --env-file "${env_file}" -f "${compose_file}" --project-directory "${repo_root}")
smoke_state_dir=""
smoke_state_file=""

cleanup_smoke_state() {
  if [[ -n "${smoke_state_file}" ]]; then
    rm -f -- "${smoke_state_file}"
  fi
  if [[ -n "${smoke_state_dir}" ]]; then
    rmdir -- "${smoke_state_dir}" 2>/dev/null || true
  fi
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required for the Hatchet qualification harness." >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "The Docker daemon is unavailable." >&2
    exit 1
  fi
}

published_port() {
  local service="$1"
  local container_port="$2"
  local binding
  binding="$("${compose[@]}" port "${service}" "${container_port}")"
  printf '%s\n' "${binding##*:}"
}

assert_service_healthy() {
  local service="$1"
  local container_id
  local health
  container_id="$("${compose[@]}" ps -q "${service}")"
  if [[ -z "${container_id}" ]]; then
    echo "Hatchet qualification service is not running: ${service}" >&2
    return 1
  fi
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_id}")"
  if [[ "${health}" != "healthy" ]]; then
    echo "Hatchet qualification service is not healthy: ${service} (${health})" >&2
    return 1
  fi
}

status() {
  "${compose[@]}" ps
  assert_service_healthy postgres
  assert_service_healthy hatchet

  local dashboard_port
  dashboard_port="$(published_port hatchet 8888)"
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${dashboard_port}/" >/dev/null
  echo "Hatchet readiness and dashboard checks passed."
}

up() {
  "${compose[@]}" up --detach --wait --wait-timeout 180 hatchet
  status
}

worker_up() {
  "${compose[@]}" up --detach --wait --wait-timeout 180 \
    hatchet kurobara-postgres
  status
  assert_service_healthy kurobara-postgres
}

down() {
  "${compose[@]}" down --remove-orphans
}

smoke() {
  up

  local dashboard_port
  local grpc_port
  local token
  dashboard_port="$(published_port hatchet 8888)"
  grpc_port="$(published_port hatchet 7077)"
  token="$("${compose[@]}" exec -T hatchet cat /config/authdisabled-token)"
  if [[ "${token}" != *.*.* || ${#token} -gt 8192 ]]; then
    echo "Hatchet Lite Dev did not return a structurally valid embedded token." >&2
    exit 1
  fi

  smoke_state_dir="$(mktemp -d "${TMPDIR:-/tmp}/kurobara-hatchet-qualification.XXXXXX")"
  smoke_state_file="${smoke_state_dir}/restart-state.json"
  trap cleanup_smoke_state EXIT

  run_smoke_phase prepare "${dashboard_port}" "${grpc_port}" "${token}" "${smoke_state_file}"

  "${compose[@]}" restart hatchet
  "${compose[@]}" up --detach --wait --wait-timeout 180 hatchet
  status

  run_smoke_phase verify "${dashboard_port}" "${grpc_port}" "${token}" "${smoke_state_file}"
  cleanup_smoke_state
  trap - EXIT
}

worker() {
  worker_up

  local dashboard_port
  local grpc_port
  local kurobara_postgres_port
  local kurobara_postgres_password
  local kurobara_postgres_url
  local token
  dashboard_port="$(published_port hatchet 8888)"
  grpc_port="$(published_port hatchet 7077)"
  kurobara_postgres_port="$(published_port kurobara-postgres 5432)"
  kurobara_postgres_password="$("${compose[@]}" exec -T kurobara-postgres printenv POSTGRES_PASSWORD)"
  token="$("${compose[@]}" exec -T hatchet cat /config/authdisabled-token)"
  if [[ "${token}" != *.*.* || ${#token} -gt 8192 ]]; then
    echo "Hatchet Lite Dev did not return a structurally valid embedded token." >&2
    exit 1
  fi
  kurobara_postgres_url="$(
    KUROBARA_QUALIFICATION_DB_PORT="${kurobara_postgres_port}" \
    KUROBARA_QUALIFICATION_DB_PASSWORD="${kurobara_postgres_password}" \
    node -e '
      const url = new URL("postgres://kurobara@127.0.0.1/kurobara");
      url.port = process.env.KUROBARA_QUALIFICATION_DB_PORT;
      url.password = process.env.KUROBARA_QUALIFICATION_DB_PASSWORD;
      process.stdout.write(url.href);
    '
  )"

  HATCHET_CLIENT_API_URL="http://127.0.0.1:${dashboard_port}" \
  HATCHET_CLIENT_HOST_PORT="127.0.0.1:${grpc_port}" \
  HATCHET_CLIENT_NAMESPACE="kurobara-qualification" \
  HATCHET_CLIENT_TLS_STRATEGY="none" \
  HATCHET_CLIENT_TOKEN="${token}" \
  KUROBARA_TEST_POSTGRES_URL="${kurobara_postgres_url}" \
    node --experimental-strip-types --test --test-concurrency=1 \
      "${repo_root}/test/integration/hatchet/worker-process.test.ts"
}

run_smoke_phase() {
  local phase="$1"
  local dashboard_port="$2"
  local grpc_port="$3"
  local token="$4"
  local state_file="$5"

  HATCHET_CLIENT_API_URL="http://127.0.0.1:${dashboard_port}" \
  HATCHET_CLIENT_HOST_PORT="127.0.0.1:${grpc_port}" \
  HATCHET_CLIENT_NAMESPACE="kurobara-qualification" \
  HATCHET_CLIENT_TLS_STRATEGY="none" \
  HATCHET_CLIENT_TOKEN="${token}" \
  KUROBARA_HATCHET_PHASE="${phase}" \
  KUROBARA_HATCHET_STATE_FILE="${state_file}" \
    node --experimental-strip-types --test --test-concurrency=1 \
      "${repo_root}/test/integration/hatchet/smoke.test.ts"
}

usage() {
  echo "Usage: $0 {up|down|status|smoke|worker}" >&2
  exit 64
}

require_docker

case "${1:-}" in
  up)
    up
    ;;
  down)
    down
    ;;
  status)
    status
    ;;
  smoke)
    smoke
    ;;
  worker)
    worker
    ;;
  *)
    usage
    ;;
esac
