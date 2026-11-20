#!/bin/sh
# Builds the release files: dist/consessus-<version>.tgz (npm pack) and dist/SHA256SUMS.txt.
# Usage: sh scripts/release-assets.sh   (dist/ is gitignored; nothing is published)
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('./package.json').version")
mkdir -p dist
rm -f "dist/consessus-$version.tgz" dist/SHA256SUMS.txt
npm pack --silent --pack-destination dist >/dev/null
test -f "dist/consessus-$version.tgz"
(cd dist && shasum -a 256 "consessus-$version.tgz" > SHA256SUMS.txt)
echo "built dist/consessus-$version.tgz"
cat dist/SHA256SUMS.txt
