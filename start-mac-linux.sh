#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Download the LTS version from https://nodejs.org and run this again."; exit 1
fi
[ -f .env ] || cp .env.example .env
echo
echo " Website:   http://localhost:3000"
echo " Dashboard: sign in with ADMIN_PASSWORD from the .env file (default admin123)"
echo " Press Ctrl+C to stop."
echo
( sleep 2; (open http://localhost:3000 || xdg-open http://localhost:3000) >/dev/null 2>&1 ) &
node server.js
