#!/bin/sh
# Run after `npx cap add android`: permissions for background playback + app icon.
set -e
MANIFEST="android/app/src/main/AndroidManifest.xml"
for perm in android.permission.WAKE_LOCK android.permission.FOREGROUND_SERVICE android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK android.permission.POST_NOTIFICATIONS; do
  grep -q "$perm" "$MANIFEST" || sed -i "s#</manifest>#    <uses-permission android:name=\"$perm\" />\n</manifest>#" "$MANIFEST"
done
# Keep media going when the screen is off: don't let the WebView pause with the activity.
MAIN=$(find android/app/src/main/java -name MainActivity.java | head -1)
if [ -n "$MAIN" ] && ! grep -q "onPause" "$MAIN"; then
  cat > "$MAIN" <<'JAVA'
package com.egzey.mytubeboss;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onPause() {
        super.onPause();
        // BridgeActivity pauses the WebView; resume it so music keeps playing in the background.
        if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().onResume();
    }
}
JAVA
fi
# App icon from assets/icon.png
if [ -f assets/icon.png ]; then
  for d in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
    name=${d%%:*}; size=${d##*:}
    dir="android/app/src/main/res/mipmap-$name"
    [ -d "$dir" ] || continue
    convert assets/icon.png -resize ${size}x${size} "$dir/ic_launcher.png"
    convert assets/icon.png -resize ${size}x${size} "$dir/ic_launcher_round.png"
    [ -f "$dir/ic_launcher_foreground.png" ] && convert assets/icon.png -resize $((size*108/48))x$((size*108/48)) -gravity center -background none -extent $((size*108/48))x$((size*108/48)) "$dir/ic_launcher_foreground.png"
  done
  rm -f android/app/src/main/res/mipmap-anydpi-v26/ic_launcher*.xml
  echo "Android icon replaced"
fi
echo "Android project patched"
