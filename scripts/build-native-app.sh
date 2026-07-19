#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/native/macos/App"

xcodegen generate
xcodebuild \
  -project VoiceVAC.xcodeproj \
  -scheme VoiceVAC \
  -configuration "${CONFIGURATION:-Debug}" \
  -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath ../.derived/VoiceVAC \
  CODE_SIGNING_ALLOWED=NO \
  build
