#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# ngrok-mpesa-tunnel.sh
#
# Starts an ngrok tunnel on port 3000, patches .env with the public URL,
# and prints ready-to-paste Postman environment variable values.
#
# Usage:
#   chmod +x scripts/ngrok-mpesa-tunnel.sh
#   ./scripts/ngrok-mpesa-tunnel.sh
#
# Prerequisites:
#   - ngrok installed and authenticated: https://ngrok.com/download
#   - jq installed: apt-get install jq / brew install jq
#   - .env file exists in the project root (one level up from scripts/)
#
# SASRA/CBK compliance note:
#   This tunnel is for sandbox development only. In production, Safaricom
#   requires a static, TLS-terminating HTTPS endpoint. Ngrok URLs are
#   ephemeral and must NEVER be used as production callback URLs.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────────────────
APP_PORT="${APP_PORT:-3000}"
NGROK_API_PORT="${NGROK_API_PORT:-4040}"
NGROK_API_URL="http://localhost:${NGROK_API_PORT}/api/tunnels"
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
MAX_WAIT_SECS=30
POLL_INTERVAL=2

# ─── Cleanup trap ─────────────────────────────────────────────────────────────
NGROK_PID=""
cleanup() {
  echo ""
  echo "🛑  Shutting down ngrok tunnel..."
  if [[ -n "$NGROK_PID" ]] && kill -0 "$NGROK_PID" 2>/dev/null; then
    kill "$NGROK_PID"
    wait "$NGROK_PID" 2>/dev/null || true
  fi
  # Restore original .env if backup exists
  if [[ -f "${ENV_FILE}.ngrok.bak" ]]; then
    mv "${ENV_FILE}.ngrok.bak" "$ENV_FILE"
    echo "✅  .env restored from backup"
  fi
  echo "🏁  Cleanup complete"
}
trap cleanup EXIT INT TERM

# ─── Dependency checks ────────────────────────────────────────────────────────
for cmd in ngrok jq curl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "❌  Required command not found: $cmd"
    echo "   Install: ngrok → https://ngrok.com/download | jq → brew install jq"
    exit 1
  fi
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌  .env not found at: $ENV_FILE"
  exit 1
fi

# ─── Check if app is running ──────────────────────────────────────────────────
echo "🔍  Checking if Beba backend is running on port ${APP_PORT}..."
if ! curl -sf "http://localhost:${APP_PORT}/api/health" &>/dev/null; then
  echo "⚠️   Backend not responding on port ${APP_PORT}."
  echo "   Start the server first: npm run start:dev"
  echo "   Continuing anyway – ngrok will tunnel regardless."
fi

# ─── Start ngrok ──────────────────────────────────────────────────────────────
echo "🚇  Starting ngrok tunnel on port ${APP_PORT}..."
ngrok http "${APP_PORT}" \
  --log=stdout \
  --log-format=json \
  --log-level=warn \
  > /tmp/ngrok-beba.log 2>&1 &
NGROK_PID=$!
echo "   ngrok PID: ${NGROK_PID}"

# ─── Health-check loop: wait for ngrok API ────────────────────────────────────
echo "⏳  Waiting for ngrok API to come up (max ${MAX_WAIT_SECS}s)..."
WAITED=0
NGROK_PUBLIC_URL=""

while [[ $WAITED -lt $MAX_WAIT_SECS ]]; do
  if ! kill -0 "$NGROK_PID" 2>/dev/null; then
    echo "❌  ngrok process died unexpectedly. Check /tmp/ngrok-beba.log"
    cat /tmp/ngrok-beba.log || true
    exit 1
  fi

  # Query ngrok API for active tunnels
  TUNNEL_JSON=$(curl -sf "${NGROK_API_URL}" 2>/dev/null || echo "")
  if [[ -n "$TUNNEL_JSON" ]]; then
    # Extract the HTTPS public URL (prefer https over http tunnel)
    NGROK_PUBLIC_URL=$(echo "$TUNNEL_JSON" | jq -r '.tunnels[] | select(.proto == "https") | .public_url' | head -1)
    if [[ -n "$NGROK_PUBLIC_URL" && "$NGROK_PUBLIC_URL" != "null" ]]; then
      break
    fi
  fi

  sleep "$POLL_INTERVAL"
  WAITED=$((WAITED + POLL_INTERVAL))
done

if [[ -z "$NGROK_PUBLIC_URL" || "$NGROK_PUBLIC_URL" == "null" ]]; then
  echo "❌  Timed out waiting for ngrok public URL after ${MAX_WAIT_SECS}s"
  echo "   Check /tmp/ngrok-beba.log for errors"
  cat /tmp/ngrok-beba.log || true
  exit 1
fi

echo "✅  ngrok tunnel active: ${NGROK_PUBLIC_URL}"

# ─── Patch .env ───────────────────────────────────────────────────────────────
echo "📝  Patching .env with new MPESA_CALLBACK_URL..."

# Back up original .env
cp "$ENV_FILE" "${ENV_FILE}.ngrok.bak"

# Build the full callback URL
MPESA_CALLBACK_URL="${NGROK_PUBLIC_URL}"

# Replace or append MPESA_CALLBACK_URL in .env
if grep -q "^MPESA_CALLBACK_URL=" "$ENV_FILE"; then
  # Portable sed: works on both Linux and macOS
  sed -i.tmp "s|^MPESA_CALLBACK_URL=.*|MPESA_CALLBACK_URL=${MPESA_CALLBACK_URL}|" "$ENV_FILE"
  rm -f "${ENV_FILE}.tmp"
else
  echo "" >> "$ENV_FILE"
  echo "MPESA_CALLBACK_URL=${MPESA_CALLBACK_URL}" >> "$ENV_FILE"
fi

echo "   MPESA_CALLBACK_URL=${MPESA_CALLBACK_URL}"
echo ""

# ─── Print Postman environment variables ─────────────────────────────────────
echo "════════════════════════════════════════════════════════════"
echo "  ✅  POSTMAN ENVIRONMENT VARIABLES (copy into Postman)"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "  NGROK_URL              = ${NGROK_PUBLIC_URL}"
echo "  BASE_URL               = http://localhost:${APP_PORT}"
echo ""
echo "  Daraja Callback URLs for Safaricom Sandbox Portal:"
echo "  STK/C2B Callback:      ${NGROK_PUBLIC_URL}/api/mpesa/callback"
echo "  B2C Result URL:        ${NGROK_PUBLIC_URL}/api/mpesa/webhooks/b2c-result"
echo "  B2C Queue Timeout URL: ${NGROK_PUBLIC_URL}/api/mpesa/webhooks/b2c-timeout"
echo ""
echo "════════════════════════════════════════════════════════════"
echo ""
echo "  ⚠️   SASRA REMINDER: This tunnel is for SANDBOX testing only."
echo "       Production requires a static TLS endpoint. Never use"
echo "       ngrok URLs as production callback URLs."
echo ""
echo "════════════════════════════════════════════════════════════"
echo ""
echo "🟢  Tunnel running. Press Ctrl+C to stop and restore .env"
echo ""

# ─── Keep alive & tail ngrok log ─────────────────────────────────────────────
# Show ngrok log output so you can see incoming requests
echo "📡  Tailing ngrok access log (Ctrl+C to stop)..."
echo ""

# Poll ngrok API every 10 seconds to verify tunnel is still alive
while kill -0 "$NGROK_PID" 2>/dev/null; do
  sleep 10
  # Verify tunnel is still up
  STILL_UP=$(curl -sf "${NGROK_API_URL}" 2>/dev/null \
    | jq -r '.tunnels[] | select(.proto == "https") | .public_url' 2>/dev/null | head -1 || echo "")
  if [[ -z "$STILL_UP" || "$STILL_UP" == "null" ]]; then
    echo "⚠️   [$(date '+%H:%M:%S')] Tunnel may have gone down – check ngrok dashboard"
  fi
done

echo "ngrok process exited"
