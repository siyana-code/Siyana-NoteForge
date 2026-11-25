#!/usr/bin/env bash
# Regenerate the offline dependency lists the Flatpak manifest needs.
# Run this after any change to package-lock.json or src-tauri/Cargo.lock.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
tools="${FLATPAK_BUILDER_TOOLS:-$root/.flatpak-builder-tools}"

if [ ! -d "$tools" ]; then
  git clone --depth 1 https://github.com/flatpak/flatpak-builder-tools "$tools"
fi

# Cargo crates
python3 -m venv "$tools/.venv"
"$tools/.venv/bin/pip" install --quiet aiohttp toml tomlkit
"$tools/.venv/bin/python" "$tools/cargo/flatpak-cargo-generator.py" \
  "$root/src-tauri/Cargo.lock" -o "$here/cargo-sources.json"

# npm packages
"$tools/.venv/bin/pip" install --quiet "$tools/node"
"$tools/.venv/bin/flatpak-node-generator" npm "$root/package-lock.json" -o "$here/node-sources.json"

echo "Wrote $here/cargo-sources.json and $here/node-sources.json"
