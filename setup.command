#!/bin/zsh
set -e
cd "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  bundled_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
  if [[ -x "$bundled_node/node" ]]; then export PATH="$bundled_node:$PATH"; else
    print "Install Node.js 22 or newer from https://nodejs.org and try again."
    read -k 1
    exit 1
  fi
fi
node scripts/setup.mjs
print "Setup complete. Double-click start.command."
read -k 1
