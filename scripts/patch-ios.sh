#!/bin/sh
# Adds background audio to the generated iOS project.
# Run once after `npx cap add ios` (npm run ios:init does it for you).
set -e
PLIST="ios/App/App/Info.plist"
DELEGATE="ios/App/App/AppDelegate.swift"

# 1) Background audio mode -> music keeps playing when the screen is locked.
/usr/libexec/PlistBuddy -c "Delete :UIBackgroundModes" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :UIBackgroundModes array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :UIBackgroundModes:0 string audio" "$PLIST"

# 2) Audio session = playback (ignores the mute switch, enables lock screen / Dynamic Island).
if ! grep -q "AVAudioSession" "$DELEGATE"; then
  perl -0pi -e 's/import UIKit/import UIKit\nimport AVFoundation/' "$DELEGATE"
  perl -0pi -e 's/(didFinishLaunchingWithOptions[^\{]*\{)/$1\n        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)\n        try? AVAudioSession.sharedInstance().setActive(true)/' "$DELEGATE"
fi
# 3) App icon from assets/icon.png (any size, square) -> 1024x1024, no alpha.
if [ -f assets/icon.png ]; then
  ICONSET="ios/App/App/Assets.xcassets/AppIcon.appiconset"
  TARGET=$(ls "$ICONSET"/*.png | head -1)
  sips -s format png -z 1024 1024 assets/icon.png --out /tmp/icon1024.png >/dev/null
  # flatten alpha onto black
  sips -s format jpeg /tmp/icon1024.png --out /tmp/icon.jpg >/dev/null && sips -s format png /tmp/icon.jpg --out "$TARGET" >/dev/null
  echo "App icon replaced: $TARGET"
fi
echo "iOS project patched: background audio on."
