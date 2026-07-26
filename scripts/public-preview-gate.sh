#!/usr/bin/env bash

set -euo pipefail

readonly CONTAINER_IMAGE="node:24.14.0-bookworm@sha256:5a593d74b632d1c6f816457477b6819760e13624455d587eef0fa418c8d0777b"
readonly CONTAINER_SCRIPT="/opt/kurobara/public-preview-gate.mjs"
readonly CONTAINER_REPORT_DIRECTORY="/root/kurobara-public-preview-reports"
readonly PRIOR_PASS_REPORT="/proof/pass-1.json"
readonly INTERNAL_PASS_ENVIRONMENT="KUROBARA_PUBLIC_PREVIEW_ISOLATED_PASS"

script_directory="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1
  pwd -P
)"
readonly gate_script="${script_directory}/public-preview-gate.mjs"

usage() {
  cat >&2 <<'EOF'
Usage: bash scripts/public-preview-gate.sh
  --repository-url <https-url>
  --expected-commit <40-char-sha>
  --expected-tag <tag>
  --artifacts-manifest-url <https-url>
  --expected-artifacts-manifest-sha256 <sha256:...>
  --passes 2
  --report-dir <absolute-new-directory>
EOF
}

fail() {
  printf '{"error_code":"%s","outcome":"failed"}\n' "$1" >&2
  usage
  exit 1
}

report_directory=""
container_arguments=()
while (($# > 0)); do
  case "$1" in
    --allow-local-test-remote)
      fail "local-test-launcher-forbidden"
      ;;
    --report-dir)
      if [[ -n "${report_directory}" || $# -lt 2 || "$2" == --* ]]; then
        fail "report-directory-invalid"
      fi
      report_directory="$2"
      container_arguments+=("--report-dir" "${CONTAINER_REPORT_DIRECTORY}")
      shift 2
      ;;
    *)
      container_arguments+=("$1")
      shift
      ;;
  esac
done

if [[ -z "${report_directory}" || "${report_directory}" != /* ]]; then
  fail "report-directory-invalid"
fi
if [[ ! -f "${gate_script}" || -L "${gate_script}" ]]; then
  fail "gate-script-invalid"
fi
if ! command -v docker >/dev/null 2>&1; then
  fail "docker-unavailable"
fi
if [[ -e "${report_directory}" ]]; then
  fail "report-directory-exists"
fi
readonly report_parent="$(dirname -- "${report_directory}")"
if [[ ! -d "${report_parent}" ]]; then
  fail "report-directory-parent-invalid"
fi

umask 077
mkdir -m 700 -- "${report_directory}"

pass_one_container=""
pass_two_container=""

cleanup() {
  local container
  if [[ -f "${report_directory}/pass-1.json" ]]; then
    chmod 600 "${report_directory}/pass-1.json" >/dev/null 2>&1 || true
  fi
  for container in "${pass_one_container}" "${pass_two_container}"; do
    if [[ -n "${container}" ]]; then
      docker rm --force --volumes "${container}" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT HUP INT TERM

create_container() {
  local pass_number="$1"
  shift
  docker create \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
    --cap-drop ALL \
    --cap-add SETUID \
    --cap-add SETGID \
    --security-opt no-new-privileges=true \
    --pids-limit 512 \
    --network bridge \
    --user 0:0 \
    --mount "type=bind,src=${gate_script},dst=${CONTAINER_SCRIPT},readonly" \
    --mount "type=volume,dst=/root" \
    "$@" \
    "${CONTAINER_IMAGE}" \
    /usr/bin/env -i \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "HOME=/tmp/launcher-home" \
    "NODE_ENV=production" \
    "COREPACK_HOME=/tmp/corepack" \
    "${INTERNAL_PASS_ENVIRONMENT}=${pass_number}" \
    node "${CONTAINER_SCRIPT}" \
    "${container_arguments[@]}"
}

copy_report() {
  local container="$1"
  local name="$2"
  docker cp \
    "${container}:${CONTAINER_REPORT_DIRECTORY}/${name}" \
    "${report_directory}/${name}"
  chmod 600 "${report_directory}/${name}"
}

pass_one_container="$(create_container 1)"
pass_one_status=0
docker start --attach "${pass_one_container}" || pass_one_status=$?
copy_report "${pass_one_container}" "pass-1.json"
docker rm --force --volumes "${pass_one_container}" >/dev/null
pass_one_container=""
if ((pass_one_status != 0)); then
  exit "${pass_one_status}"
fi

chmod 444 "${report_directory}/pass-1.json"
pass_two_container="$(
  create_container 2 \
    --mount "type=bind,src=${report_directory}/pass-1.json,dst=${PRIOR_PASS_REPORT},readonly"
)"
pass_two_status=0
docker start --attach "${pass_two_container}" || pass_two_status=$?
chmod 600 "${report_directory}/pass-1.json"
copy_report "${pass_two_container}" "pass-2.json"
copy_report "${pass_two_container}" "summary.json"
docker rm --force --volumes "${pass_two_container}" >/dev/null
pass_two_container=""
exit "${pass_two_status}"
