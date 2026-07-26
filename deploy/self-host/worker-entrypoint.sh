#!/usr/bin/env sh

set -eu

token_file="${HATCHET_CLIENT_TOKEN_FILE:-/hatchet-config/authdisabled-token}"
attempt=0
while [ ! -r "${token_file}" ] && [ "${attempt}" -lt 60 ]; do
  attempt=$((attempt + 1))
  sleep 1
done

if [ ! -r "${token_file}" ]; then
  echo "Hatchet worker token file is not readable." >&2
  exit 1
fi

HATCHET_CLIENT_TOKEN="$(sed -n '1p' "${token_file}")"
case "${HATCHET_CLIENT_TOKEN}" in
  *.*.*) ;;
  *)
    echo "Hatchet worker token file is malformed." >&2
    exit 1
    ;;
esac
if [ "${#HATCHET_CLIENT_TOKEN}" -gt 8192 ]; then
  echo "Hatchet worker token exceeds the supported bound." >&2
  exit 1
fi
export HATCHET_CLIENT_TOKEN
unset token_file attempt

exec "$@"
