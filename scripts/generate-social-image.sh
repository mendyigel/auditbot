#!/bin/bash
# generate-social-image.sh — Generate social media images via Pollinations.ai
# Usage: ./scripts/generate-social-image.sh "post topic" [output_path]
#
# Free, no API key required. Uses image.pollinations.ai URL-based API.
# Brand: OrbioLab / AuditBot — navy+teal, flat isometric, no faces.

set -euo pipefail

TOPIC="${1:?Usage: $0 \"post topic\" [output_path]}"
OUTPUT="${2:-/tmp/social-image-$(date +%s).jpg}"

# Brand style prefix applied to all prompts
STYLE_PREFIX="professional flat isometric illustration, navy blue and teal color scheme, clean modern data-driven aesthetic, no human faces, no text overlay, minimal design"

# URL-encode the prompt
PROMPT=$(node -e "console.log(encodeURIComponent('${STYLE_PREFIX}, ${TOPIC}'))")

# X/Twitter optimal: 1200x675 (16:9)
# LinkedIn optimal: 1200x627
# Using 1200x675 as universal default
WIDTH="${WIDTH:-1200}"
HEIGHT="${HEIGHT:-675}"
SEED="${SEED:--1}"

URL="https://image.pollinations.ai/prompt/${PROMPT}?width=${WIDTH}&height=${HEIGHT}&seed=${SEED}&nologo=true"

echo "Generating image for: ${TOPIC}"
echo "Output: ${OUTPUT}"

HTTP_CODE=$(curl -s -o "${OUTPUT}" -w "%{http_code}" "${URL}" --max-time 120)

if [ "${HTTP_CODE}" = "200" ]; then
  SIZE=$(stat -c%s "${OUTPUT}" 2>/dev/null || stat -f%z "${OUTPUT}" 2>/dev/null)
  echo "Success: ${OUTPUT} (${SIZE} bytes)"
else
  echo "Error: HTTP ${HTTP_CODE}" >&2
  rm -f "${OUTPUT}"
  exit 1
fi
