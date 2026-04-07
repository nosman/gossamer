#!/usr/bin/env bash
# Build and package Gossamer as a .vsix file for local installation.
# Usage: ./scripts/package-vsix.sh
# Install: code --install-extension gossamer.vsix
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE_DIR="packages/vscode/bundled-server"

# ── 1. Build ──────────────────────────────────────────────────────────────────
echo "==> Building core + server..."
npm run build

echo "==> Building extension + webview..."
npm run build -w packages/vscode

# ── 2. Bundle server ──────────────────────────────────────────────────────────
echo "==> Bundling server..."
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/node_modules"

# Bundle all pure-JS deps inline; keep native packages as runtime externals.
node_modules/.bin/esbuild dist/serve.js \
  --bundle \
  --platform=node \
  --format=esm \
  --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);" \
  --outfile="$BUNDLE_DIR/serve.js" \
  --external:better-sqlite3 \
  --external:node-pty \
  --external:fsevents \
  --log-level=warning

# ── 3. Copy schema SQL (used by pushSchema() at runtime to initialise the DB) ─
echo "==> Copying schema SQL..."
cp packages/core/prisma/schema.sql "$BUNDLE_DIR/schema.sql"

# ── 4. Copy native packages and their deps ────────────────────────────────────
echo "==> Copying native modules..."
NM="node_modules"

copy_module() {
  local pkg="$1"
  if [ -d "$NM/$pkg" ]; then
    mkdir -p "$BUNDLE_DIR/node_modules/$(dirname "$pkg")"
    cp -r "$NM/$pkg" "$BUNDLE_DIR/node_modules/$pkg"
  else
    echo "    warning: $NM/$pkg not found, skipping"
  fi
}

# better-sqlite3 and its loader deps
copy_module better-sqlite3
copy_module bindings
copy_module file-uri-to-path

# node-pty (loads from prebuilds/)
copy_module node-pty
copy_module node-addon-api

# ── 5. Package VSIX ───────────────────────────────────────────────────────────
echo "==> Packaging VSIX..."
OUT="$(pwd)/gossamer.vsix"
cd packages/vscode
npx --yes @vscode/vsce package \
  --no-dependencies \
  --allow-missing-repository \
  --out "$OUT"

echo ""
echo "Done! Install with:"
echo "  code --install-extension $OUT"
