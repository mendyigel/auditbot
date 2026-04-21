#!/usr/bin/env bash
# Trigger a Render deploy via deploy hook.
# Usage: ./scripts/deploy.sh
#
# Requires RENDER_DEPLOY_HOOK_URL environment variable.
# Optionally pushes code first if --push flag is provided.

set -euo pipefail

if [ -z "${RENDER_DEPLOY_HOOK_URL:-}" ]; then
  echo "ERROR: RENDER_DEPLOY_HOOK_URL is not set." >&2
  echo "Set it to the Render deploy hook URL before running this script." >&2
  exit 1
fi

PUSH=false
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=true ;;
  esac
done

if [ "$PUSH" = true ]; then
  echo "Pushing code to remote..."
  git push
  echo "Push complete."
fi

echo "Triggering Render deploy..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$RENDER_DEPLOY_HOOK_URL")

if [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 300 ]; then
  echo "Deploy triggered successfully (HTTP $HTTP_STATUS)."
else
  echo "ERROR: Deploy hook returned HTTP $HTTP_STATUS." >&2
  exit 1
fi
