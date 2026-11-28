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

# Allow rotating the phone (portrait + both landscapes) for the landscape layouts.
/usr/libexec/PlistBuddy -c "Delete :UISupportedInterfaceOrientations" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :UISupportedInterfaceOrientations array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :UISupportedInterfaceOrientations:0 string UIInterfaceOrientationPortrait" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :UISupportedInterfaceOrientations:1 string UIInterfaceOrientationLandscapeLeft" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :UISupportedInterfaceOrientations:2 string UIInterfaceOrientationLandscapeRight" "$PLIST"

# 2) Audio session = playback (ignores the mute switch, enables lock screen / Dynamic Island).
if ! grep -q "AVAudioSession" "$DELEGATE"; then
  perl -0pi -e 's/import UIKit/import UIKit\nimport AVFoundation/' "$DELEGATE"
  perl -0pi -e 's/(didFinishLaunchingWithOptions[^\{]*\{)/$1\n        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)\n        try? AVAudioSession.sharedInstance().setActive(true)/' "$DELEGATE"
fi
# 2b) In-app Google login: append the native plugin and use our bridge controller (registers it).
if ! grep -q "GoogleLoginPlugin" "$DELEGATE"; then
  sed '/^import /d' native/ios/GoogleLogin.swift > /tmp/gl.swift
  grep -q "^import WebKit" "$DELEGATE" || perl -0pi -e 's/import UIKit/import UIKit\nimport WebKit/' "$DELEGATE"
  grep -q "^import Capacitor" "$DELEGATE" || perl -0pi -e 's/import UIKit/import UIKit\nimport Capacitor/' "$DELEGATE"
  cat /tmp/gl.swift >> "$DELEGATE"
fi
if ! grep -q "class MTBEnergyPlugin" "$DELEGATE"; then
  printf '\n' >> "$DELEGATE"
  cat native/ios/MTBEnergy.swift >> "$DELEGATE"
fi
STORY="ios/App/App/Base.lproj/Main.storyboard"
perl -pi -e 's/customClass="CAPBridgeViewController" customModule="Capacitor"/customClass="MTBBridgeViewController" customModule="App" customModuleProvider="target"/' "$STORY"
grep -q "MTBBridgeViewController" "$STORY" && echo "Google login plugin wired"

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
