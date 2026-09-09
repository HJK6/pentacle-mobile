#!/usr/bin/env sh
# B3 guard (camera regression): assert the GENERATED iOS Info.plist carries the
# camera + photo-library purpose strings. Run AFTER `expo prebuild -p ios`.
#
# Why: `ios/` is gitignored/generated. A stale or incremental prebuild once shipped a
# plist with only NSFaceIDUsageDescription, so launchCameraAsync hard-failed on iOS
# (camera "did nothing") while the PHPicker photo-library path — which needs no purpose
# string — still worked. The fix declares both strings explicitly in app.config.ts
# `ios.infoPlist`; this guard fails the build if a future regen drops them.
set -e
PLIST="ios/Pentacle/Info.plist"
if [ ! -f "$PLIST" ]; then
  echo "verify:ios-permissions: $PLIST not found — run 'expo prebuild -p ios' first." >&2
  exit 2
fi
missing=""
for key in NSCameraUsageDescription NSPhotoLibraryUsageDescription; do
  grep -q "$key" "$PLIST" || missing="$missing $key"
done
if [ -n "$missing" ]; then
  echo "verify:ios-permissions: FAIL — missing in $PLIST:$missing" >&2
  echo "  Fix: ensure ios.infoPlist in app.config.ts declares them, then 'expo prebuild -p ios --clean'." >&2
  exit 1
fi
echo "verify:ios-permissions: OK — camera + photo purpose strings present in $PLIST"
