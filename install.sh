#!/usr/bin/env bash
# Install the latest Sketchnote release for the current user:
#
#     curl -fsSL https://get.sketchnote.workers.dev/install | bash
#
# Needs GNOME 50 on x86_64 with AVX2, FMA and F16C, plus ffmpeg and pw-record. Puts the
# binary in ~/.local/bin and the extension in ~/.local/share/gnome-shell/extensions, and
# writes the D-Bus file that starts the service on demand. Safe to re-run. It doesn't ask
# anything (its stdin is the script itself); `sketchnote setup` does that afterwards.
# SKETCHNOTE_RELEASE_URL installs from elsewhere, e.g. .../releases/download/v0.0.1.
set -euo pipefail

RELEASE="${SKETCHNOTE_RELEASE_URL:-https://github.com/BilalIrfanContact/sketchnote/releases/latest/download}"
UUID=sketchnote@local
BIN="$HOME/.local/bin/sketchnote"
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
DBUS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/dbus-1/services"

# The install command for `debian fedora arch` packages, for this distro.
install_cmd() {
    local id
    id=$(. /etc/os-release 2>/dev/null; echo "${ID:-} ${ID_LIKE:-}")   # ID_LIKE is optional
    case "$id" in
        *debian*|*ubuntu*) echo "sudo apt install $1" ;;
        *fedora*) echo "sudo dnf install $2" ;;
        *arch*) echo "sudo pacman -S $3" ;;
        *) echo "install $1 with your package manager" ;;
    esac
}

problems=()
[[ "$(uname -m)" == x86_64 ]] || problems+=("Sketchnote only runs on x86_64 (this machine is $(uname -m)).")
shell=$(gnome-shell --version 2>/dev/null || true)     # "GNOME Shell 50.1"
major=$(sed -E 's/^GNOME Shell ([0-9]+).*/\1/' <<<"$shell")
if [[ -z "$shell" ]]; then
    problems+=("Sketchnote requires GNOME 50, and GNOME Shell isn't installed here.")
elif [[ "$major" != 50 ]]; then
    problems+=("Sketchnote requires GNOME 50, and this is $shell.")
fi
missing_flags=()
for flag in avx2 fma f16c; do
    grep -qw "$flag" /proc/cpuinfo || missing_flags+=("$flag")
done
((${#missing_flags[@]} == 0)) ||
    problems+=("This CPU lacks ${missing_flags[*]}, which Sketchnote's speech model needs (most CPUs since about 2015 have them).")
command -v ffmpeg >/dev/null ||
    problems+=("ffmpeg is missing. Install it with: $(install_cmd ffmpeg ffmpeg-free ffmpeg)")
command -v pw-record >/dev/null ||
    problems+=("pw-record (PipeWire's recorder) is missing. Install it with: $(install_cmd pipewire-bin pipewire-utils pipewire)")
if ((${#problems[@]})); then
    echo "Sketchnote can't be installed yet:" >&2
    printf '  - %s\n' "${problems[@]}" >&2
    exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "== Downloading Sketchnote"
for file in sketchnote sketchnote-extension.tar.gz; do
    curl -fL --progress-bar -o "$tmp/$file" "$RELEASE/$file"
done

echo "== $BIN"
mkdir -p "$(dirname "$BIN")"
install -m 755 "$tmp/sketchnote" "$BIN.new"
mv -f "$BIN.new" "$BIN"   # a rename, so a running service keeps its old copy

echo "== GNOME Shell extension -> $EXT_DIR"
rm -rf "$EXT_DIR"         # also drops a build-from-source symlink (the link, not its target)
mkdir -p "$EXT_DIR"
tar -xzf "$tmp/sketchnote-extension.tar.gz" -C "$EXT_DIR"

echo "== D-Bus activation for org.sketchnote.Service"
mkdir -p "$DBUS_DIR"
cat > "$DBUS_DIR/org.sketchnote.Service.service" <<EOF
[D-BUS Service]
Name=org.sketchnote.Service
Exec=$BIN service
EOF
# A service still running an older binary quits once nothing is recording or building;
# D-Bus then starts the new one on demand.
gdbus call --session --dest org.sketchnote.Service --object-path /org/sketchnote/Service \
    --method org.sketchnote.Service.QuitWhenIdle >/dev/null 2>&1 || true

echo "== Enabling the extension"
gnome-extensions enable "$UUID" 2>/dev/null || {
    # GNOME only discovers new extensions at login; enable it for the next session.
    current=$(gsettings get org.gnome.shell enabled-extensions)
    if [[ "$current" != *"'$UUID'"* ]]; then
        if [[ "$current" == "@as []" || "$current" == "[]" ]]; then current="['$UUID']"
        else current="${current%]}, '$UUID']"; fi
        gsettings set org.gnome.shell enabled-extensions "$current"
    fi
}

echo
command -v sketchnote >/dev/null && run=sketchnote || run=$BIN
echo "Installed. Now run: $run setup"
if ! LC_ALL=C gnome-extensions info "$UUID" 2>/dev/null | grep -q "State: ACTIVE"; then
    echo "The extension isn't active yet: log out and back in once (GNOME on Wayland only loads new extensions at login)."
fi
