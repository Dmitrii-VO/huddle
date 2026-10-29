#!/bin/sh
# Release a new desktop app version: sh deploy/release-app.sh 0.2.1
# Bumps app/package.json, commits, tags vX.Y.Z and pushes; GitHub Actions builds and publishes it,
# installed apps then offer the update.
set -e
V=$1
[ -n "$V" ] || { echo "usage: $0 X.Y.Z"; exit 1; }
cd "$(dirname "$0")/.."
(cd app && npm version "$V" --no-git-tag-version --allow-same-version >/dev/null)
git commit -qam "App v$V" || true # nothing to commit when the version was bumped by hand
git tag "v$V"
git push -q
git push -q origin "v$V"
echo "Building v$V: https://github.com/Dmitrii-VO/huddle/actions"
