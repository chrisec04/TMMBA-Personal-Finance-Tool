#!/usr/bin/env sh
# Run the Personal Finance Tool on macOS or Linux.
#
# Installs dependencies on first run, starts the app, and opens it in your browser.
# No API key is needed to look around.
#
# If double-clicking does nothing, the file may have lost its executable bit in transit:
#   chmod +x start.sh

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js is not installed, or is not on your PATH."
  echo
  echo "  Install it from https://nodejs.org and run this again."
  echo
  exit 1
fi

exec node scripts/start.mjs "$@"
