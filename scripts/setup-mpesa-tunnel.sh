#!/usr/bin/env bash
# scripts/setup-mpesa-tunnel.sh
#
# Sprint 4 – M-Pesa Integration Hardening
# ────────────────────────────────────────
# Waits for the Dockerised Ngrok sidecar to establish an HTTPS tunnel, then
# patches all Daraja callback URLs in .env so the running NestJS app can
# receive Safaricom webhook POSTs without any manual URL copy-paste.
#
# Companion to: docker-compose.override.yml
# Replaces:     scripts/ngrok-mpesa-tunnel.sh (host-process ngrok)
#
# Usage:
#   bash scripts/setup-mpesa-tunnel.sh
#   bash scripts/setup-mpesa-tunnel.sh --env .env.local
#   bash scripts/setup-mpesa-tunnel.sh --env .env --no-b2c
#
# Prerequisites:
#   docker compose -f docker-compose.yml -f docker-compose.override.yml up -d
#   (Ngrok container must be running before this script is invoked.)
#
# SASRA/CBK: For sandbox testing only. Ngrok URLs are ephemeral and must
# NEVER be used as production Daraja callback URLs.
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${PROJECT_ROOT}/.env"
NGROK_API_URL="http://localhost:4040/api/tunnels"
NGROK_CONTAINER="beba_ngrok_sprint4"
MAX_WAIT_SECS=90
POLL_INTERVAL=3
PATCH_B2C=true

# Daraja callback path – must match your NestJS @Post() controller route
STK_CALLBACK_PATH="/api/mpesa/callback"
B2C_RESULT_PATH="/api/mpesa/webhooks/b2c-result"
B2C_TIMEOUT_PATH="/api/mpesa/webhooks/b2c-timeout"

# ── Argument parsing ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)     ENV_FILE="$2"; shift 2 ;;
    --no-b2c)  PATCH_B2C=false; shift ;;
    -h|--help)
      sed -n '2,30p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ── Terminal colours (disabled if not a tty) ──────────────────────────────────
if [[ -t 1 ]]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
  BLUE='\033[0;34m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; BOLD=''; DIM=''; NC=''
fi

log()   { echo -e "${GREEN}[setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[warn] ${NC} $*"; }
error() { echo -e "${RED}[error]${NC} $*" >&2; }
info()  { echo -e "${DIM}[info] ${NC} $*"; }

# ── Cleanup trap ──────────────────────────────────────────────────────────────
cleanup() {
  local code=$?
  [[ $code -ne 0 ]] && {
    error "Setup failed (exit ${code})."
    error "Debug: docker compose logs ngrok"
    error "       curl -s ${NGROK_API_URL} | python3 -m json.tool"
  }
}
trap cleanup EXIT

# ── Dependency checks ─────────────────────────────────────────────────────────
for cmd in curl docker; do
  command -v "$cmd" &>/dev/null || {
    error "Required command '${cmd}' not found. Install it and retry."
    exit 1
  }
done

# ── JSON parsing: prefer jq, fall back to python3, then python ────────────────
# Extracts the first HTTPS public_url from the Ngrok /api/tunnels response.
extract_https_url() {
  local json="$1"
  if command -v jq &>/dev/null; then
    # -e returns non-zero if the result is null/false — safe with set -e
    echo "$json" | jq -re '[.tunnels[] | select(.proto=="https")] | first | .public_url' 2>/dev/null || true
  elif command -v python3 &>/dev/null; then
    echo "$json" | python3 - <<'PY'
import sys, json
data = json.load(sys.stdin)
urls = [t["public_url"] for t in data.get("tunnels", []) if t.get("proto") == "https"]
print(urls[0] if urls else "", end="")
PY
  elif command -v python &>/dev/null; then
    echo "$json" | python - <<'PY'
import sys, json
data = json.load(sys.stdin)
urls = [t["public_url"] for t in data.get("tunnels", []) if t.get("proto") == "https"]
print(urls[0] if urls else "")
PY
  else
    error "Neither jq nor python/python3 is available."
    error "Install one: brew install jq  |  apt-get install -y jq"
    exit 1
  fi
}

# ── Verify Ngrok container is running ─────────────────────────────────────────
log "Checking for container '${NGROK_CONTAINER}'..."
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "${NGROK_CONTAINER}"; then
  error "Container '${NGROK_CONTAINER}' is not running."
  error "Start the Sprint 4 stack first:"
  error "  docker compose -f docker-compose.yml -f docker-compose.override.yml up -d"
  exit 1
fi
log "Container found."

# ── host.docker.internal sanity note ─────────────────────────────────────────
# On Linux with Docker Engine, the Ngrok container reaches the NestJS app via
# the host-gateway extra_hosts mapping. If NestJS is NOT running on host:3000,
# the tunnel will establish but all incoming Daraja requests will return 502.
# Docker Desktop users: host.docker.internal is resolved natively; no action needed.

# ── Wait for HTTPS tunnel ─────────────────────────────────────────────────────
log "Waiting up to ${MAX_WAIT_SECS}s for Ngrok HTTPS tunnel..."
elapsed=0
PUBLIC_URL=""

while [[ $elapsed -lt $MAX_WAIT_SECS ]]; do
  response="$(curl -sf --max-time 3 "${NGROK_API_URL}" 2>/dev/null || true)"
  if [[ -n "$response" ]]; then
    url="$(extract_https_url "$response" || true)"
    if [[ -n "$url" && "$url" != "null" ]]; then
      PUBLIC_URL="$url"
      break
    fi
  fi
  printf "${DIM}.${NC}"
  sleep "${POLL_INTERVAL}"
  elapsed=$(( elapsed + POLL_INTERVAL ))
done

echo ""   # newline after progress dots

if [[ -z "$PUBLIC_URL" ]]; then
  error "No HTTPS tunnel established after ${MAX_WAIT_SECS}s."
  info  "Raw API response:"
  curl -sf "${NGROK_API_URL}" 2>/dev/null \
    | (command -v python3 &>/dev/null && python3 -m json.tool || cat) \
    || echo "  <no response from ${NGROK_API_URL}>"
  error "Check NGROK_AUTHTOKEN in .env and inspect logs:"
  error "  docker compose -f docker-compose.yml -f docker-compose.override.yml logs ngrok"
  exit 1
fi

log "Tunnel established → ${PUBLIC_URL}"

# ── Build callback URLs ───────────────────────────────────────────────────────
STK_CALLBACK_URL="${PUBLIC_URL}${STK_CALLBACK_PATH}"
B2C_RESULT_URL="${PUBLIC_URL}${B2C_RESULT_PATH}"
B2C_TIMEOUT_URL="${PUBLIC_URL}${B2C_TIMEOUT_PATH}"

# ── Ensure .env file exists ───────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  warn ".env not found at '${ENV_FILE}' — creating empty file."
  touch "$ENV_FILE"
fi

# ── Idempotent env-file patcher ───────────────────────────────────────────────
# Replaces an existing KEY=... line in place; appends if key is absent.
# Handles BSD sed (macOS: -i '') and GNU sed (Linux: -i).
_sed_inplace() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

patch_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "${ENV_FILE}" 2>/dev/null; then
    _sed_inplace "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
    log "Updated  ${key}"
  else
    # Append with a blank separator if last line is not blank
    [[ -s "$ENV_FILE" ]] && [[ "$(tail -c1 "$ENV_FILE" | wc -l)" -eq 0 ]] && echo "" >> "$ENV_FILE"
    echo "${key}=${value}" >> "${ENV_FILE}"
    log "Appended ${key}"
  fi
}

# Patch primary STK/C2B callback
patch_env "MPESA_CALLBACK_URL" "${STK_CALLBACK_URL}"

# Patch B2C URLs (present in .env — skip with --no-b2c if not needed)
if [[ "$PATCH_B2C" == "true" ]]; then
  patch_env "MPESA_B2C_RESULT_URL"        "${B2C_RESULT_URL}"
  patch_env "MPESA_B2C_QUEUE_TIMEOUT_URL" "${B2C_TIMEOUT_URL}"
fi

# Also sync the Postman environment JSON if it exists alongside this script
POSTMAN_ENV="${SCRIPT_DIR}/mpesa-sprint4.postman_environment.json"
if [[ -f "$POSTMAN_ENV" ]] && command -v python3 &>/dev/null; then
  python3 - "$POSTMAN_ENV" "$PUBLIC_URL" <<'PY'
import sys, json

env_path, ngrok_url = sys.argv[1], sys.argv[2]
with open(env_path, "r") as f:
    data = json.load(f)

for v in data.get("values", []):
    if v.get("key") == "NGROK_URL":
        v["value"] = ngrok_url

with open(env_path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")

print(f"  synced NGROK_URL in {env_path}")
PY
  log "Synced Postman environment JSON"
fi

# ── Print summary ─────────────────────────────────────────────────────────────
SEP="──────────────────────────────────────────────────────────────────"
echo ""
echo -e "${BLUE}${SEP}${NC}"
echo -e "${BOLD}  Sprint 4 — M-Pesa Tunnel Ready${NC}"
echo -e "${BLUE}${SEP}${NC}"
printf "  %-28s %s\n" "Ngrok public URL"       "${YELLOW}${PUBLIC_URL}${NC}"
printf "  %-28s %s\n" "STK / C2B callback"     "${YELLOW}${STK_CALLBACK_URL}${NC}"
if [[ "$PATCH_B2C" == "true" ]]; then
  printf "  %-28s %s\n" "B2C result URL"         "${YELLOW}${B2C_RESULT_URL}${NC}"
  printf "  %-28s %s\n" "B2C timeout URL"        "${YELLOW}${B2C_TIMEOUT_URL}${NC}"
fi
printf "  %-28s %s\n" "Redis UI (BullMQ)"       "${YELLOW}http://localhost:8081${NC}"
printf "  %-28s %s\n" "Ngrok web inspector"     "${YELLOW}http://localhost:4040${NC}"
printf "  %-28s %s\n" "Env file patched"        "${DIM}${ENV_FILE}${NC}"
echo -e "${BLUE}${SEP}${NC}"
echo ""

warn "Reload NestJS to pick up the new callback URLs in .env:"
echo "  npm run start:dev     # stop with Ctrl-C, then restart"
echo ""
warn "Register callbacks on the Daraja sandbox portal:"
SHORTCODE="${MPESA_SHORTCODE:-174379}"
echo "  Confirmation URL : ${STK_CALLBACK_URL}"
echo "  Validation URL   : ${PUBLIC_URL}/api/mpesa/validate"
echo ""
info "Inspector: http://localhost:4040"
info "BullMQ:    http://localhost:8081  →  filter key prefix: bull:*"
echo ""
info "SASRA reminder: ngrok URLs are ephemeral. Never use in production."
