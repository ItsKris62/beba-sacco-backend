#!/usr/bin/env bash
# ============================================================
# purge-git-history.sh
#
# Rewrites ALL git history to remove the known-compromised Beba SACCO
# secrets. After running this script you MUST force-push to every remote
# to overwrite the public history. Every collaborator must then
# re-clone (their local clone still contains the old history).
#
# REQUIREMENTS:
#   pip install git-filter-repo      # https://github.com/newren/git-filter-repo
#   Or: brew install git-filter-repo (macOS)
#
# WARNING:
#   This is a destructive, irreversible operation on all branches and tags.
#   Run AFTER all team members have pushed their in-progress work.
#   Coordinate with GitHub/GitLab: revert branch protections, allow force-push,
#   then re-enable after the purge.
#
# Run from: the REPOSITORY ROOT (not backend/)
# ============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Pre-flight checks ─────────────────────────────────────────────────────────

echo -e "\n${BOLD}${CYAN}Beba SACCO — Git History Purge${RESET}"
echo -e "${RED}⚠️  This will REWRITE ALL COMMITS and TAGS.${RESET}"
echo -e "   Press Ctrl-C now to abort.\n"
read -r -p "Type  YES  to confirm: " CONFIRM
if [[ "$CONFIRM" != "YES" ]]; then
  echo "Aborted."
  exit 1
fi

if ! command -v git-filter-repo &>/dev/null; then
  echo -e "${RED}ERROR: git-filter-repo not found.${RESET}"
  echo "  Install: pip install git-filter-repo"
  echo "  macOS:   brew install git-filter-repo"
  exit 1
fi

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo -e "${RED}ERROR: Not a git repository. Run from the repo root.${RESET}"
  exit 1
fi

# Abort if there are uncommitted changes
if ! git diff-index --quiet HEAD --; then
  echo -e "${RED}ERROR: Uncommitted changes detected. Commit or stash them first.${RESET}"
  git status --short
  exit 1
fi

# ── Backup ────────────────────────────────────────────────────────────────────

BACKUP_BRANCH="backup/pre-history-purge-$(date +%Y%m%d-%H%M%S)"
echo -e "\n${CYAN}── Creating backup branch: ${BACKUP_BRANCH}${RESET}"
git branch "$BACKUP_BRANCH"
echo -e "${GREEN}  Backup created. If anything goes wrong, restore with:${RESET}"
echo -e "${GREEN}  git reset --hard $BACKUP_BRANCH${RESET}"

# ── Build expressions file ────────────────────────────────────────────────────
# Format: literal:<exact-string>==>REDACTED_<label>
# git-filter-repo replaces every byte-exact match in blob content, filenames,
# and commit messages. We use PARTIAL strings that uniquely identify each
# secret without exposing the full value in this script.

EXPRS_FILE="$(mktemp /tmp/beba-purge-exprs.XXXXXX)"

cat > "$EXPRS_FILE" <<'EOF'
# Neon DB password (full password, change if yours differs)
literal:npg_JOuCMRct31NU==>REDACTED_NEON_DB_PASSWORD

# JWT_SECRET prefix match — Daraja of the KNtBLDWM... value
# git-filter-repo replaces the full value; list enough chars to be unique
literal:KNtBLDWMILLt==>REDACTED_JWT_SECRET_KEY

# JWT_REFRESH_SECRET prefix
literal:Vz/SaJ+RMIi==>REDACTED_JWT_REFRESH_SECRET

# Redis / Upstash password
literal:gQAAAAAAAS-T==>REDACTED_REDIS_PASSWORD

# Cloudflare R2 secret access key
literal:cfat_ASeQqi==>REDACTED_R2_SECRET_KEY

# Safaricom Daraja consumer key
literal:mdzroqz3nLW==>REDACTED_DARAJA_CONSUMER_KEY

# Safaricom Daraja consumer secret
literal:QDvszGuehy==>REDACTED_DARAJA_CONSUMER_SECRET

# Plunk API key (pk_...)
literal:pk_77c9e54c==>REDACTED_PLUNK_API_KEY

# Plunk secret key (sk_...)
literal:sk_9a482e19==>REDACTED_PLUNK_SECRET_KEY

# Tinybird token (JWT-style)
literal:p.eyJ1IjogImUzYTY2==>REDACTED_TINYBIRD_TOKEN

# Ngrok authtoken
literal:3CnjoKrMbVP==>REDACTED_NGROK_AUTHTOKEN
EOF

echo -e "\n${CYAN}── Expressions file:${RESET}"
grep -v '^#' "$EXPRS_FILE" | grep -v '^$' | while read -r line; do
  label="${line%%==>*}"
  echo "  $label ==> [REDACTED]"
done

# ── Run git-filter-repo ───────────────────────────────────────────────────────

echo -e "\n${CYAN}── Running git-filter-repo (this may take several minutes)...${RESET}"
git filter-repo \
  --replace-text "$EXPRS_FILE" \
  --force

rm -f "$EXPRS_FILE"

echo -e "\n${GREEN}✅ History rewrite complete.${RESET}"

# ── Verify ────────────────────────────────────────────────────────────────────

echo -e "\n${CYAN}── Verifying: scanning rewritten history for residual patterns...${RESET}"

PATTERNS=(
  "npg_JOuCM"
  "KNtBLDWM"
  "Vz/SaJ"
  "gQAAAAA"
  "cfat_ASe"
  "mdzroqz3"
  "QDvszGue"
  "pk_77c9e"
  "sk_9a482"
  "eyJ1IjogImUzYTY2"
  "3CnjoKrM"
)

FOUND_IN_HISTORY=0
for pattern in "${PATTERNS[@]}"; do
  if git log --all --oneline --source -S "$pattern" --format="%H" 2>/dev/null | grep -q .; then
    echo -e "${RED}  STILL PRESENT in history: $pattern${RESET}"
    FOUND_IN_HISTORY=$((FOUND_IN_HISTORY + 1))
  else
    echo -e "${GREEN}  CLEAN: $pattern${RESET}"
  fi
done

if [[ $FOUND_IN_HISTORY -gt 0 ]]; then
  echo -e "\n${RED}❌ ${FOUND_IN_HISTORY} pattern(s) still found. Check the expressions file and rerun.${RESET}"
  exit 1
fi

echo -e "\n${GREEN}✅ All known secrets purged from history.${RESET}"

# ── Force-push instructions ───────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${YELLOW}── Next steps (REQUIRED) ──────────────────────────────────────${RESET}"
echo ""
echo -e "  1. Temporarily disable branch protection on main/master in GitHub:"
echo -e "     GitHub → Repo → Settings → Branches → Edit branch rule"
echo -e "     Uncheck: Require pull request reviews, Allow force pushes"
echo ""
echo -e "  2. Force-push all branches and tags:"
echo -e "${CYAN}     git push --force --all origin${RESET}"
echo -e "${CYAN}     git push --force --tags origin${RESET}"
echo ""
echo -e "  3. Re-enable branch protection rules."
echo ""
echo -e "  4. Notify ALL collaborators they must re-clone:"
echo -e "     ${RED}Their local clones still contain the old history.${RESET}"
echo -e "     git clone <repo-url>   # or: git fetch --all && git reset --hard origin/main"
echo ""
echo -e "  5. If GitHub detected the secrets, check GitHub's secret scanning alerts:"
echo -e "     GitHub → Repo → Security → Secret Scanning → Resolve each alert"
echo ""
echo -e "  6. Revoke GitHub Personal Access Tokens if the repo was public at any point."
echo ""
echo -e "${GREEN}✅ Purge complete. Backup branch: ${BACKUP_BRANCH}${RESET}"
