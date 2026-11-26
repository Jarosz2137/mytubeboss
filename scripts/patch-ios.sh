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
echo "iOS project patched: background audio on."
