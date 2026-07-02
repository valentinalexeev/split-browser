# Disk-space cleanup commands for a sprite that's filling up or already
# reporting ENOSPC / "No space left on device" (see troubleshooting.md #7).
#
# Same caveat as install-deps.sh: Sprites:exec's cmd is NOT shell-parsed.
# Run each of these as its own Sprites:exec call, or wrap the whole batch
# in Sprites:service_create with cmd="bash", args=["-c", "<joined with &&>"].
#
# None of this touches the Chrome profile's cookies, localStorage, or login
# state — only caches and installer leftovers. See the "what NOT to delete"
# note at the bottom before running anything against a profile that's
# currently logged in.

# 1. Check what's actually taking up space before guessing
df -h /
du -sh /home/sprite/pw/* 2>/dev/null
du -sh ~/.cache/ms-playwright/* 2>/dev/null

# 2. apt: drop downloaded .deb archives and now-unused packages
sudo apt-get clean
sudo apt-get autoremove -y
# Package lists get re-downloaded on the next `apt-get update` — safe to
# drop if you're not about to install more system packages right away.
sudo rm -rf /var/lib/apt/lists/*

# 3. npm cache (safe — npm re-populates it on demand)
npm cache clean --force

# 4. Playwright browsers this skill doesn't use. This skill only ever
#    launches real Chrome (`channel: 'chrome'`) — never the Chromium/
#    Firefox/WebKit builds Playwright bundles. If a bare `npx playwright
#    install` (no browser name) was ever run on this sprite instead of
#    `npx playwright install chrome`, it silently pulled all of them
#    (1GB+ combined). List what's there, then remove anything that isn't
#    the `chrome-*` dir (that's the real Chrome binary in use):
ls ~/.cache/ms-playwright/
rm -rf ~/.cache/ms-playwright/chromium-*
rm -rf ~/.cache/ms-playwright/firefox-*
rm -rf ~/.cache/ms-playwright/webkit-*
#    Preventively, always install with an explicit browser name
#    (`npx playwright install chrome`) — never the bare form — so this
#    never accumulates in the first place.

# 5. Chrome profile caches — regenerate automatically, safe to clear even
#    on a live/logged-in profile.
rm -rf /home/sprite/pw/chrome-profile/Default/Cache
rm -rf "/home/sprite/pw/chrome-profile/Default/Code Cache"
rm -rf /home/sprite/pw/chrome-profile/Default/GPUCache
rm -rf "/home/sprite/pw/chrome-profile/Default/Service Worker/CacheStorage"
# Crash dumps pile up if the script has crashed/auto-restarted repeatedly
# (see troubleshooting.md #1 and #6) — purely diagnostic, safe to delete.
rm -rf "/home/sprite/pw/chrome-profile/Crashpad"

# 6. Leftover profile/script dirs from earlier attempts on this same sprite
#    (chrome-profile2, old pw-nav/pw-nav2 scripts from the unique-service-
#    name churn described in troubleshooting.md #1). Check what's actually
#    still referenced by a running service (Sprites:service_list) before
#    deleting anything here — don't remove a profile dir a live service is
#    still using.
ls -la /home/sprite/pw/

# --- What NOT to delete on a profile you still need logged in ---
# Default/Cookies, Default/Local Storage, Default/IndexedDB,
# Default/Session Storage — these ARE the login session. Deleting them is
# equivalent to logging the user out and starting over.
