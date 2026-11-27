#!/bin/sh
# Run after `npx cap sync ios` (sync rewrites this file): register our in-app plugin so
# Capacitor loads it like any npm plugin.
set -e
CFG="ios/App/App/capacitor.config.json"
node -e '
const fs=require("fs"); const f=process.argv[1]; const c=JSON.parse(fs.readFileSync(f,"utf8"));
c.packageClassList=Array.from(new Set([...(c.packageClassList||[]),"GoogleLoginPlugin","MTBBrowserPlugin"]));
fs.writeFileSync(f,JSON.stringify(c,null,2)); console.log("packageClassList:",c.packageClassList.join(", "));
' "$CFG"
