#!/usr/bin/env bash
#
# Deploy this project to the Raspberry Pi.
#
#   ./deploy.sh              # deploy
#   ./deploy.sh --dry-run    # show what would change, touch nothing
#   ./deploy.sh --prune      # also delete Pi files no longer in the repo
#
# The Pi's copy is NOT a git clone -- it's a plain directory kept in sync from
# here with rsync. So this script stamps the deployed commit into
# .deployed-commit on the Pi, which is the only record of what's running there.
#
# Secrets and machine-local config (.env, blind-sensor-map.json) live only on
# the Pi and are never transferred or deleted.

set -euo pipefail

PI_HOST="${PI_HOST:-pi@pi.local}"
PI_DIR="${PI_DIR:-/home/pi/ring-local-enhancements}"
PM2_APP="${PM2_APP:-ring-local-enhancements}"

DRY_RUN=0
PRUNE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --prune)   PRUNE=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^#//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Never transferred. .env and blind-sensor-map.json are the Pi's own; the rest
# is either local build state or meaningless on the target.
EXCLUDES=(
  --exclude .git
  --exclude node_modules
  --exclude .env
  --exclude .env.pi.bak
  --exclude blind-sensor-map.json
  --exclude .DS_Store
  --exclude scratchpad
)

# --- Preflight -------------------------------------------------------------
# Deploying a dirty tree ships code that exists nowhere in history, which makes
# the commit stamp on the Pi a lie. Refuse.

say "Preflight"

# Untracked files get rsynced too, so they count as dirty -- otherwise the
# commit stamped on the Pi wouldn't describe what actually landed there.
# Ignored files (.env, node_modules) are excluded by --porcelain.
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  fail "Working tree is dirty (including untracked files). Commit, stash, or gitignore them first."
fi

COMMIT="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "  commit:  ${COMMIT:0:8} on ${BRANCH}"

# Warn (don't block) if the commit isn't on the remote -- deploying something
# unpushed is legitimate in a pinch, but you should know you're doing it.
if git remote | head -1 | grep -q .; then
  REMOTE="$(git remote | head -1)"
  if git fetch --quiet "$REMOTE" 2>/dev/null && \
     ! git merge-base --is-ancestor "$COMMIT" "$REMOTE/$BRANCH" 2>/dev/null; then
    echo "  WARNING: ${COMMIT:0:8} is not on $REMOTE/$BRANCH -- deploying unpushed code"
  fi
fi

say "Running tests locally"
npm test

say "Checking the Pi is reachable"
ssh -o ConnectTimeout=10 -o BatchMode=yes "$PI_HOST" "test -d '$PI_DIR'" \
  || fail "Cannot reach $PI_HOST, or $PI_DIR does not exist there."

PREVIOUS="$(ssh "$PI_HOST" "cat '$PI_DIR/.deployed-commit' 2>/dev/null || echo unknown")"
echo "  currently deployed: $PREVIOUS"

# --- Sync ------------------------------------------------------------------

RSYNC_ARGS=(-az --human-readable "${EXCLUDES[@]}")
[ "$PRUNE" -eq 1 ] && RSYNC_ARGS+=(--delete)

if [ "$DRY_RUN" -eq 1 ]; then
  say "Dry run -- files that would change"
  rsync "${RSYNC_ARGS[@]}" --dry-run --itemize-changes ./ "$PI_HOST:$PI_DIR/"
  echo
  echo "Nothing was changed. Re-run without --dry-run to deploy."
  exit 0
fi

say "Syncing to $PI_HOST:$PI_DIR"
rsync "${RSYNC_ARGS[@]}" --itemize-changes ./ "$PI_HOST:$PI_DIR/"

# --- Install, verify, restart ----------------------------------------------
# Tests run again on the Pi: it's a different arch and Node build, and a green
# run here doesn't prove anything about there.

say "Installing dependencies and testing on the Pi"
ssh "$PI_HOST" "cd '$PI_DIR' && npm ci --no-audit --no-fund && npm test"

say "Restarting $PM2_APP"
ssh "$PI_HOST" "cd '$PI_DIR' && printf '%s\n' '$COMMIT' > .deployed-commit && pm2 restart '$PM2_APP' --update-env && pm2 save --force"

say "Verifying"
sleep 5
STATUS="$(ssh "$PI_HOST" "pm2 jlist" | node -e "
  let raw='';
  process.stdin.on('data', d => raw += d);
  process.stdin.on('end', () => {
    const app = JSON.parse(raw).find(a => a.name === '$PM2_APP');
    if (!app) { console.log('missing'); return; }
    console.log(app.pm2_env.status + ' restarts=' + app.pm2_env.restart_time);
  });
")"
echo "  pm2: $STATUS"
case "$STATUS" in
  online*) ;;
  *) fail "App is not online after restart. Check: ssh $PI_HOST 'pm2 logs $PM2_APP --lines 50'" ;;
esac

say "Recent log output"
ssh "$PI_HOST" "pm2 logs '$PM2_APP' --lines 25 --nostream" || true

printf '\n\033[32mDeployed %s -> %s (was %s)\033[0m\n' \
  "${COMMIT:0:8}" "$PI_HOST:$PI_DIR" "${PREVIOUS:0:8}"
printf 'Rollback: git checkout %s && ./deploy.sh\n' "${PREVIOUS:0:8}"
