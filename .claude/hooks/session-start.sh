#!/bin/bash
# Prepares Claude Code on the web sessions to typecheck, lint, test, and build.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# The repo pins Node in .node-version; cloud images may ship a different major.
NODE_VERSION="$(tr -d '[:space:]' < .node-version)"
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64 | arm64) NODE_ARCH=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
NODE_DIR="$HOME/.local/node/node-v${NODE_VERSION}-linux-${NODE_ARCH}"

if [ ! -x "$NODE_DIR/bin/node" ]; then
  mkdir -p "$(dirname "$NODE_DIR")"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    | tar -xJ -C "$(dirname "$NODE_DIR")"
fi

export PATH="$NODE_DIR/bin:$PATH"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$NODE_DIR/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

# npm install (not npm ci) reuses node_modules from the cached container state.
npm install --no-audit --no-fund
