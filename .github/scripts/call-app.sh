#!/usr/bin/env bash
# Calls a scheduler-facing route of the deployed app and writes the response body to <output-file>
# and the HTTP status to <output-file>.status. Authenticates with this run's GitHub OIDC token
# (the app trusts main-branch tokens of its own repository), or CRON_SECRET when set.
# Usage: call-app.sh <path> <output-file> [max-seconds]
set -uo pipefail
path="$1"; out="$2"; max="${3:-60}"
APP_URL="${APP_URL:-https://supliments-pi.vercel.app}"
if [ -n "${CRON_SECRET:-}" ]; then
  token="$CRON_SECRET"
elif [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
  token=$(curl -sS -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=supliments-cron" | jq -r .value)
else
  echo "::error title=No credential::the job needs 'permissions: id-token: write' (or a CRON_SECRET secret)."
  exit 1
fi
code=$(curl -sS -o "$out" -w '%{http_code}' --max-time "$max" --retry 2 --retry-delay 5 \
  -H "Authorization: Bearer ${token}" "${APP_URL%/}${path}") || {
  echo "::error title=App unreachable::Could not reach ${APP_URL} (curl exit $?)."
  exit 1
}
echo "$code" > "$out.status"
if [ "$code" = 404 ]; then
  echo "::error title=${path} returned 404::The app did not accept this run's credential (ref ${GITHUB_REF:-?}). Only runs on main are trusted; check CRON_GITHUB_REPOSITORY in Vercel and that this build is deployed."
  exit 1
fi
if [ "$code" = 401 ] || [ "$code" = 403 ]; then
  echo "::error title=${path} returned ${code}::Vercel Deployment Protection is blocking the production domain; protect previews only."
  exit 1
fi
