#!/usr/bin/env bash
set -euo pipefail

workspace="$(cd "$(dirname "$0")/.." && pwd)"
npm run build:headless --workspace @voivox/desktop

cd "$workspace/native/macos/App"
xcodegen generate
rm -rf "$workspace/native/macos/build"
xcodebuild \
  -project VoiceVAC.xcodeproj \
  -target VoiceVAC \
  -configuration Release \
  -sdk macosx \
  CONFIGURATION_BUILD_DIR="$workspace/native/macos/build" \
  CODE_SIGNING_ALLOWED=NO \
  build

printf 'Built %s\n' "$workspace/native/macos/build/Voice VAC.app"
