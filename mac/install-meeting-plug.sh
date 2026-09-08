#!/bin/bash
#
# Install the MeetingBar -> smart plug bridge on this Mac.
#
#   ./install-meeting-plug.sh --url http://192.168.1.104:8787 --token <MEETING_PLUG_TOKEN>
#
# Prompts for anything not passed. Installs three things:
#
#   ~/.local/bin/meeting-plug-notify              the helper that calls the Pi
#   ~/.config/meeting-plug/config                 the Pi's URL + shared secret
#   ~/Library/Application Scripts/leits.MeetingBar/joinEventScript.scpt
#
# The token must match MEETING_PLUG_TOKEN in the Pi's .env.

set -euo pipefail

cd "$(dirname "$0")"

SCRIPT_DIR="$HOME/Library/Application Scripts/leits.MeetingBar"
HELPER="$HOME/.local/bin/meeting-plug-notify"
CONFIG_DIR="$HOME/.config/meeting-plug"
CONFIG="$CONFIG_DIR/config"

URL=""
TOKEN=""
INSTALL_SCRIPT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --url)       URL="${2:-}"; shift 2 ;;
    --token)     TOKEN="${2:-}"; shift 2 ;;
    --no-script) INSTALL_SCRIPT=0; shift ;;
    -h|--help)   sed -n '2,16p' "$0" | sed 's/^#//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "This installer is for macOS."

if [ -z "$URL" ]; then
  printf 'Pi base URL [http://pi.local:8787]: '
  read -r URL
  URL="${URL:-http://pi.local:8787}"
fi
URL="${URL%/}"

if [ -z "$TOKEN" ]; then
  printf 'MEETING_PLUG_TOKEN (from the Pi'\''s .env): '
  read -rs TOKEN
  echo
fi
[ -n "$TOKEN" ] || fail "A token is required -- the Pi rejects unauthenticated requests."

say "Installing the helper"
mkdir -p "$(dirname "$HELPER")"
install -m 755 meeting-plug-notify "$HELPER"
echo "  $HELPER"

say "Writing config"
mkdir -p "$CONFIG_DIR"
umask 077
cat > "$CONFIG" <<EOF
# Written by install-meeting-plug.sh -- holds the shared secret, keep it 0600.
MEETING_PLUG_URL=$URL
MEETING_PLUG_TOKEN=$TOKEN
EOF
chmod 600 "$CONFIG"
echo "  $CONFIG (0600)"

if [ "$INSTALL_SCRIPT" -eq 1 ]; then
  say "Installing the MeetingBar join script"
  # The folder is created by MeetingBar itself. If it is missing, MeetingBar has
  # never been pointed at a script and the sandbox bookmark doesn't exist yet.
  [ -d "$SCRIPT_DIR" ] || fail "$SCRIPT_DIR does not exist.
  Open MeetingBar > Preferences > Advanced, tick 'Run AppleScript when joining a
  meeting', click 'Edit script' and pick that folder. Then re-run this."

  if [ -f "$SCRIPT_DIR/joinEventScript.scpt" ]; then
    BACKUP="$SCRIPT_DIR/joinEventScript.scpt.bak.$(date +%Y%m%d%H%M%S)"
    cp "$SCRIPT_DIR/joinEventScript.scpt" "$BACKUP"
    echo "  backed up the old script to $(basename "$BACKUP")"
  fi
  osacompile -o "$SCRIPT_DIR/joinEventScript.scpt" joinEventScript.applescript
  echo "  $SCRIPT_DIR/joinEventScript.scpt"
fi

say "Checking the Pi answers"
if OUT=$("$HELPER" --status 2>&1); then
  echo "  $OUT"
else
  echo "  Could not reach the Pi: $OUT"
  echo "  The Mac side is installed; fix the Pi (or the URL/token) and re-check with:"
  echo "    $HELPER --status"
fi

cat <<EOF

Done. Remaining manual step, in MeetingBar > Preferences > Advanced:

  * tick "Run AppleScript when joining a meeting"
  * click "Edit script" once and select
    User > Library > Application Scripts > leits.MeetingBar

Then join a meeting. Useful commands:

  $HELPER --status     what the Pi thinks is running
  $HELPER --end        switch off now, ending the current meeting early
  tail -f ~/Library/Logs/meeting-plug.log

EOF
