#!/bin/sh
# Ship current code to the VPS (ssh alias "cloud") and restart. Run from repo root.
set -e
tar -cf - server.js package.json package-lock.json public |
  ssh cloud 'sudo tar -xf - -C /opt/huddle && cd /opt/huddle && sudo npm install --omit=dev --silent && sudo systemctl restart huddle && systemctl is-active huddle'
