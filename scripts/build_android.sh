#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ANDROID_DIR="$PROJECT_DIR/android"
APK_SOURCE="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
APK_DESTINATION="$PROJECT_DIR/downloads/earth-tracker.apk"

if [[ ! -f "$ANDROID_DIR/local.properties" ]]; then
  ANDROID_SDK_PATH="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
  if [[ -z "$ANDROID_SDK_PATH" ]]; then
    echo "Set ANDROID_SDK_ROOT or create android/local.properties before building." >&2
    exit 1
  fi
  printf 'sdk.dir=%s\n' "$ANDROID_SDK_PATH" > "$ANDROID_DIR/local.properties"
fi

"$ANDROID_DIR/gradlew" --project-dir "$ANDROID_DIR" clean testDebugUnitTest lintDebug assembleDebug --warning-mode all
mkdir -p "$PROJECT_DIR/downloads"
cp "$APK_SOURCE" "$APK_DESTINATION"

echo "APK ready: $APK_DESTINATION"
