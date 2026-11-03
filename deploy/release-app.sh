#!/bin/sh
# Release a new desktop app version: sh deploy/release-app.sh 0.2.1
# Bumps app/package.json, commits, tags vX.Y.Z and pushes; GitHub Actions builds and publishes it,
# installed apps then offer the update.
set -e
V=$1
[ -n "$V" ] || { echo "usage: $0 X.Y.Z"; exit 1; }
cd "$(dirname "$0")/.."
# Release only committed code: the tag must point at what was reviewed and passed the commit hooks.
git diff --quiet HEAD || { echo "Uncommitted changes: commit them first (the hooks must pass), then release."; exit 1; }
(cd app && npm version "$V" --no-git-tag-version --allow-same-version >/dev/null)
# Only the version files; a rejected commit (hook) stops here via set -e, before any tag exists.
git diff --quiet HEAD -- app/package.json app/package-lock.json || git commit -q -m "App v$V" -- app/package.json app/package-lock.json
git tag "v$V"
git push -q
git push -q origin "v$V"
echo "Building v$V: https://github.com/Dmitrii-VO/huddle/actions"
