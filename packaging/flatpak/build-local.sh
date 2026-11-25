#!/usr/bin/env bash
# Build and install the Flatpak from the local checkout (not the git tag),
# to test packaging before a release.
#   ./packaging/flatpak/build-local.sh && flatpak run io.github.siyana_code.NoteForge
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
app=io.github.siyana_code.NoteForge

[ -f "$here/cargo-sources.json" ] && [ -f "$here/node-sources.json" ] || "$here/generate-sources.sh"

# Same manifest, but with the git source swapped for this directory.
local_manifest="$here/$app.local.yml"
python3 - "$here/$app.yml" "$local_manifest" "$root" <<'EOF'
import re, sys
src, dst, root = sys.argv[1:]
text = open(src).read()
text = re.sub(
    r"      - type: git\n        url: .*\n        tag: .*\n",
    f"      - type: dir\n        path: {root}\n        skip:\n          - node_modules\n          - dist\n          - src-tauri/target\n          - .flatpak-builder\n          - .flatpak-builder-tools\n",
    text,
)
open(dst, "w").write(text)
EOF

flatpak install --user -y --noninteractive flathub \
  org.gnome.Platform//51 org.gnome.Sdk//51 \
  org.freedesktop.Sdk.Extension.rust-stable//26.08 \
  org.freedesktop.Sdk.Extension.node24//26.08

cd "$here"
flatpak-builder --user --install --force-clean --state-dir="$root/.flatpak-builder" \
  build-dir "$local_manifest"
rm -f "$local_manifest"
