#!/usr/bin/env bash
# ============================================================
# audit-secrets.sh
#
# Scans the local working directory and (optionally) git history
# for patterns matching the known-compromised Beba SACCO secrets.
#
# Usage:
#   bash scripts/audit-secrets.sh           # scan working directory only
#   bash scripts/audit-secrets.sh --git     # also scan all git commits
#
# This script does NOT print secret values — it prints file paths
# and line numbers only. Review matches manually.
#
# Requirements: grep, git (optional), find
# Run from: backend/ directory root
# ============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

SCAN_GIT=false
if [[ "${1:-}" == "--git" ]]; then
  SCAN_GIT=true
fi

FOUND=0

header() { echo -e "\n${CYAN}── $1 ──${RESET}"; }
match() {
  FOUND=$((FOUND+1))
  echo -e "${RED}  MATCH${RESET}  $1"
}
clean() { echo -e "${GREEN}  CLEAN${RESET}  $1"; }

# ── Known compromised secret fragments ────────────────────────────────────────
# These are partial strings — enough to identify without reproducing the full secret.
declare -A PATTERNS=(
  ["Neon DB password"]="npg_JOuCM"
  ["JWT_SECRET (leaked)"]="KNtBLDWMILL"
  ["JWT_REFRESH_SECRET (leaked)"]="Vz/SaJ+RMI"
  ["Redis password (leaked)"]="gQAAAAAAAS-T"
  ["R2 secret key (leaked)"]="cfat_ASeQqi"
  ["Daraja consumer key (leaked)"]="mdzroqz3nLW"
  ["Daraja consumer secret (leaked)"]="QDvszGuehy"
  ["Plunk API key (leaked)"]="pk_77c9e54c"
  ["Plunk secret key (leaked)"]="sk_9a482e19"
  ["Tinybird token (leaked)"]="p.eyJ1IjogImUzYTY2"
  ["Ngrok authtoken (leaked)"]="3CnjoKrMbVP"
)

# ── Scan working directory ─────────────────────────────────────────────────────
header "Scanning working directory for compromised secrets"
echo "  (Skipping: node_modules/, dist/, .git/)"

EXCLUDE_DIRS="--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude-dir=coverage"
EXCLUDE_FILES="--exclude=*.log --exclude=audit-secrets.sh"

for label in "${!PATTERNS[@]}"; do
  pattern="${PATTERNS[$label]}"
  results=$(grep -r $EXCLUDE_DIRS $EXCLUDE_FILES \
    --include="*.ts" --include="*.js" --include="*.json" \
    --include="*.env" --include="*.env.*" --include="*.yaml" --include="*.yml" \
    --include="*.md" --include="*.sh" \
    -l "$pattern" . 2>/dev/null || true)

  if [[ -n "$results" ]]; then
    echo -e "  ${RED}FOUND${RESET}  [$label]"
    while IFS= read -r file; do
      lines=$(grep -n "$pattern" "$file" | cut -d: -f1 | tr '\n' ',')
      match "  → $file (lines: ${lines%,})"
    done <<< "$results"
  else
    clean "[$label]"
  fi
done

# ── Check .gitignore ─────────────────────────────────────────────────────────
header "Verifying .gitignore protection"

check_gitignore() {
  local pattern="$1"
  local label="$2"
  if grep -q "$pattern" .gitignore 2>/dev/null; then
    clean "$label is in .gitignore"
  else
    match "$label is NOT in .gitignore — add it immediately"
  fi
}

check_gitignore "^\.env$" ".env"
check_gitignore "^\.env\." ".env.* wildcard"
check_gitignore "^\.env\.production" ".env.production"

# ── Check git-tracked files ────────────────────────────────────────────────────
header "Checking git-tracked files for secrets"

if git rev-parse --git-dir > /dev/null 2>&1; then
  tracked_secrets=$(git ls-files | xargs grep -l \
    "npg_JOuCM\|KNtBLDWM\|Vz/SaJ\|gQAAAAA\|cfat_ASe\|mdzroqz3\|QDvszGue\|pk_77c9e\|sk_9a482\|eyJ1IjogImUzYTY2\|3CnjoKrM" \
    2>/dev/null || true)

  if [[ -n "$tracked_secrets" ]]; then
    echo -e "${RED}  ⛔ CRITICAL: Git-tracked files contain exposed secrets:${RESET}"
    while IFS= read -r file; do
      match "  → $file (is tracked by git)"
    done <<< "$tracked_secrets"
    echo ""
    echo -e "${RED}  ACTION REQUIRED: Run git history cleanup (see Part 5 of playbook)${RESET}"
  else
    clean "No git-tracked files contain known exposed secrets"
  fi

  # Check if .env.production is tracked
  if git ls-files --error-unmatch .env.production > /dev/null 2>&1; then
    match ".env.production IS TRACKED BY GIT — remove from tracking immediately"
    echo "    Fix: git rm --cached .env.production && git commit -m 'chore: remove tracked secret file'"
  else
    clean ".env.production is not git-tracked"
  fi

  if git ls-files --error-unmatch .env > /dev/null 2>&1; then
    match ".env IS TRACKED BY GIT — remove from tracking immediately"
    echo "    Fix: git rm --cached .env && git commit -m 'chore: remove tracked secret file'"
  else
    clean ".env is not git-tracked"
  fi

else
  echo -e "${YELLOW}  Not a git repository — skipping git tracking checks${RESET}"
fi

# ── Scan git history (optional) ───────────────────────────────────────────────
if $SCAN_GIT; then
  header "Scanning git commit history (this may take a while)"

  if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo "  Not a git repository — skipping"
  else
    COMMIT_COUNT=$(git rev-list --all --count 2>/dev/null || echo "0")
    echo "  Scanning $COMMIT_COUNT commits..."

    for label in "${!PATTERNS[@]}"; do
      pattern="${PATTERNS[$label]}"
      commits=$(git log --all --oneline --source \
        -S "$pattern" --format="%H %s" 2>/dev/null || true)

      if [[ -n "$commits" ]]; then
        echo -e "  ${RED}HISTORY MATCH${RESET}  [$label] found in commits:"
        echo "$commits" | head -5 | while read -r line; do
          match "  → $line"
        done
        FOUND=$((FOUND+1))
      else
        clean "[$label] not found in git history"
      fi
    done
  fi
fi

# ── Summary ────────────────────────────────────────────────────────────────────
header "Summary"
if [[ $FOUND -eq 0 ]]; then
  echo -e "${GREEN}✅ No compromised secrets found in working directory.${RESET}"
  echo "   Run with --git flag to also scan commit history."
  exit 0
else
  echo -e "${RED}❌ Found $FOUND location(s) containing compromised secrets.${RESET}"
  echo "   Rotate the affected secrets immediately and purge from git history."
  echo "   See: scripts/ playbook, Part 5 (Git History Cleanup)"
  exit 1
fi
