#!/usr/bin/env bash
# Build the patched React (vendor/react) packages our workspace consumes.
#
# Uses scripts/rollup/build.js directly (~13s for our bundle set) rather than
# `yarn build` (build-all-release-channels.js), which builds every channel for
# minutes and overwrites packages/shared/ReactVersion.js with a placeholder.
#
# Artifacts land in vendor/react/build/oss-experimental/{react,react-dom,scheduler}.
# The workspace consumes them via `link:` overrides in the root package.json, so
# a rebuild is picked up without re-running pnpm install.
#
# The built react-dom resolves `scheduler`/`react` by walking up its real path
# into vendor/react/node_modules, where yarn links point at *source* packages;
# the node_modules dir of symlinks created below fixes resolution.
set -euo pipefail

cd "$(dirname "$0")/../vendor/react"

ENTRIES="react/index,react/jsx,react/compiler-runtime,react-dom/index,react-dom/client,react-dom/test-utils,scheduler"

# Locally, pin the node version React's own CI uses (.nvmrc) via mise; in CI
# (or anywhere without mise) use whatever node is on PATH.
if command -v mise >/dev/null 2>&1; then
  NODE_RUNNER=(mise exec "node@$(tr -d 'v[:space:]' <.nvmrc)" -- node)
else
  NODE_RUNNER=(node)
fi

RELEASE_CHANNEL=experimental "${NODE_RUNNER[@]}" \
  ./scripts/rollup/build.js "$ENTRIES" --type=NODE_DEV,NODE_PROD

rm -rf build/oss-experimental
mv build/node_modules build/oss-experimental

cd build/oss-experimental
mkdir -p node_modules
for pkg in react react-dom scheduler; do
  ln -sfn "../$pkg" "node_modules/$pkg"
done

echo "Built: $(node -p "require('./react/package.json').version") ($(git -C ../.. rev-parse --short HEAD))"
