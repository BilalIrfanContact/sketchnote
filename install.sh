#!/usr/bin/env bash
# Install Sketchnote for the current user (GNOME 50, Wayland). Safe to re-run.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
UUID=sketchnote@local
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
DBUS_DIR="$HOME/.local/share/dbus-1/services"

echo "== Python venv with faster-whisper"
[ -x "$HERE/.venv/bin/python" ] || python3 -m venv "$HERE/.venv"
"$HERE/.venv/bin/pip" install -q faster-whisper
echo "   downloading the 'small' model (first run only)"
"$HERE/.venv/bin/python" -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"

echo "== GNOME Shell extension -> $EXT_DIR"
mkdir -p "$(dirname "$EXT_DIR")"
ln -sfn "$HERE/extension/$UUID" "$EXT_DIR"

echo "== D-Bus activation for org.sketchnote.Service"
mkdir -p "$DBUS_DIR"
cat > "$DBUS_DIR/org.sketchnote.Service.service" <<EOF
[D-BUS Service]
Name=org.sketchnote.Service
Exec=$HERE/sketchnote service
EOF

# Older versions added GNOME custom shortcuts for pasting; the extension handles it now.
KEYS=org.gnome.settings-daemon.plugins.media-keys
list=$(gsettings get $KEYS custom-keybindings)
for id in sketchnote-paste-text sketchnote-paste-image; do
    path="/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/$id/"
    if [[ "$list" == *"'$path'"* ]]; then
        echo "== Removing the old $id shortcut"
        gsettings reset-recursively $KEYS.custom-keybinding:"$path"
        list=$(sed -e "s|'$path'||; s|\[, |[|; s|, ,|,|; s|, \]|]|" <<<"$list")
    fi
done
[[ "$list" == "[]" ]] && list="@as []"
gsettings set $KEYS custom-keybindings "$list"

echo "== Enabling the extension"
if ! gnome-extensions enable "$UUID" 2>/dev/null; then
    # GNOME only discovers new extensions at login; enable it for the next session.
    current=$(gsettings get org.gnome.shell enabled-extensions)
    if [[ "$current" != *"'$UUID'"* ]]; then
        if [[ "$current" == "@as []" || "$current" == "[]" ]]; then current="['$UUID']"
        else current="${current%]}, '$UUID']"; fi
        gsettings set org.gnome.shell enabled-extensions "$current"
    fi
    echo "   Log out and back in once: GNOME on Wayland only loads new extensions at login."
fi
echo "Done. Press Alt+Shift+S to start a capture."
