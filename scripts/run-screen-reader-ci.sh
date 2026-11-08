#!/usr/bin/env bash
set -euo pipefail

# Isolated existing CI runner only: never changes a developer's accessibility settings.
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_OS:-}" = Linux
out="$PWD/test-results/screen-reader"
prefs="$RUNNER_TEMP/farda-orca-prefs"
mkdir -p "$out" "$prefs"
export NO_AT_BRIDGE=0 ACCESSIBILITY_ENABLED=1 GNOME_ACCESSIBILITY=1
export GTK_MODULES=gail:atk-bridge
export FARDA_SCREEN_READER_LOG="$out/orca-debug.log"
export FARDA_SCREEN_READER_PROOF="$out/checkpoints.jsonl"
export XDG_RUNTIME_DIR="$RUNNER_TEMP/farda-at-runtime"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
gsettings set org.gnome.desktop.interface toolkit-accessibility true
openbox > "$out/window-manager.log" 2>&1 &
wm_pid=$!
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=farda_at >/dev/null
pactl set-default-sink farda_at
speech-dispatcher -d -l 3 -L "$out"
cat > "$prefs/user-settings.conf" <<'JSON'
{"general":{"startingProfile":["Default","default"],"activeProfile":["Default","default"],"enableSpeech":true,"enableBraille":false,"speechServerFactory":"speechdispatcherfactory"},"pronunciations":{},"keybindings":{},"profiles":{"default":{"profile":["Default","default"],"enableSpeech":true,"enableBraille":false,"speechServerFactory":"speechdispatcherfactory","pronunciations":{},"keybindings":{}}}}
JSON
cat > "$prefs/orca-customizations.py" <<'PY'
import orca.debug
orca.debug.debugLevel = orca.debug.LEVEL_INFO
PY
orca --replace --user-prefs="$prefs" --enable=speech --disable=braille --debug-file="$FARDA_SCREEN_READER_LOG" > "$out/orca-process.log" 2>&1 &
orca_pid=$!
python3 -c 'import time;print(int(time.time()*1000))' > "$out/recording-start-ms.txt"
parec --device=farda_at.monitor --format=s16le --rate=22050 --channels=1 --file-format=wav "$out/speech.wav" &
record_pid=$!
cleanup() {
  kill -INT "$record_pid" 2>/dev/null || true
  wait "$record_pid" 2>/dev/null || true
  kill "$orca_pid" "$wm_pid" 2>/dev/null || true
}
trap cleanup EXIT
for attempt in $(seq 1 30); do
  if test -f "$FARDA_SCREEN_READER_LOG" && grep -q 'SPEECH: Initialized' "$FARDA_SCREEN_READER_LOG"; then break; fi
  sleep 1
done
grep -q 'SPEECH: Using speech server factory:' "$FARDA_SCREEN_READER_LOG"
orca --version > "$out/versions.txt"
speech-dispatcher --version >> "$out/versions.txt"
node --version >> "$out/versions.txt"
set +e
node node_modules/playwright/cli.js test -c playwright.agent.config.ts --headed --workers=1 e2e-agent/action-review.spec.ts e2e-agent/lifecycle.spec.ts > "$out/browser.log" 2>&1
browser_status=$?
set -e
kill -INT "$record_pid" 2>/dev/null || true
wait "$record_pid" 2>/dev/null || true
grep 'SPEECH OUTPUT:' "$FARDA_SCREEN_READER_LOG" > "$out/spoken-output.txt" || true
python3 scripts/verify-screen-reader-audio.py "$out"
cat "$out/browser.log"
exit "$browser_status"
