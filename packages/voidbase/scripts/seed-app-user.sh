#!/usr/bin/env bash
# Creates the app user the differential suites and the starter expect (user@example.com / changeme123) on a
# server, idempotently. Works against voidbase and PocketBase alike.
#   scripts/seed-app-user.sh [url=http://127.0.0.1:5180]
set -euo pipefail
URL="${1:-http://127.0.0.1:5180}"
SU_EMAIL="${VOIDBASE_SUPERUSER_EMAIL:-admin@example.com}"; SU_PASSWORD="${VOIDBASE_SUPERUSER_PASSWORD:-changeme123}"
USER_EMAIL="${REFERENCE_USER_EMAIL:-user@example.com}"; USER_PASSWORD="${REFERENCE_USER_PASSWORD:-changeme123}"
TOKEN=$(curl -s -X POST "$URL/api/collections/_superusers/auth-with-password" -H "content-type: application/json" -d "{\"identity\":\"$SU_EMAIL\",\"password\":\"$SU_PASSWORD\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || { echo "superuser login failed at $URL"; exit 1; }
existing=$(curl -s "$URL/api/collections/users/records?filter=email%3D%27$USER_EMAIL%27" -H "authorization: $TOKEN" | sed -n 's/.*"totalItems":\([0-9]*\).*/\1/p')
if [ "${existing:-0}" = "0" ]; then
  curl -s -o /dev/null -w "user $USER_EMAIL at $URL: HTTP %{http_code}\n" -X POST "$URL/api/collections/users/records" -H "content-type: application/json" -H "authorization: $TOKEN" -d "{\"email\":\"$USER_EMAIL\",\"password\":\"$USER_PASSWORD\",\"passwordConfirm\":\"$USER_PASSWORD\"}"
else echo "user $USER_EMAIL already present at $URL"; fi
