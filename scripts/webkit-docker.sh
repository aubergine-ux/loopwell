#!/bin/sh
# Runs browser test suites in WebKit (Safari's engine) inside Playwright's Ubuntu image, for systems where
# WebKit's own libraries can't be installed. Build first (npm run build), then: scripts/webkit-docker.sh run mix ...
set -e
cd "$(dirname "$0")/.."
version=$(node -p "require('playwright-core/package.json').version")
for suite in "$@"; do
  echo "== $suite"
  docker run --rm --init --ipc=host --user "$(id -u):$(id -g)" -e HOME=/tmp -e BROWSER=webkit \
    -v "$PWD":"$PWD" -w "$PWD" "mcr.microsoft.com/playwright:v$version-noble" \
    xvfb-run -a node --import tsx "tests/e2e/$suite.ts" 2>&1 | grep -E "FAIL|passed|failed" | cut -c1-300 || true
done
