---
name: split-browser
description: "Sets up a cloud browser on a Sprite (Sprites.dev) that a human watches/controls via noVNC to manually complete OAuth/Google/SSO logins, CAPTCHAs, MFA or passkeys that Claude cannot do itself, after which Claude drives that SAME already-authenticated Chrome via Playwright to navigate, scrape, or automate the site. Use whenever the user wants to automate a site behind a human-required login step (sign in with Google/Microsoft/SSO, MFA, passkeys, CAPTCHA), build a 'split browser' / human-in-the-loop setup, watch a remote automated browser live, or work around 'this browser may not be secure' / bot-detection errors from a headless or vanilla-Playwright browser. Also trigger when the user mentions Sprites + Playwright + noVNC, or wants to reuse/extend a prior browser-automation-on-a-sprite setup, or just says 'log into X for me' / 'automate X, it needs Google login', or when a sprite from a prior run of this skill has become unresponsive or is reporting it's out of disk space."
---

# Sprite Browser + noVNC Human-in-the-Loop OAuth

## What this solves

Many real websites cannot be logged into by a fully automated Playwright browser:
- "Sign in with Google" / Microsoft / SSO flows often show **"This browser may not be secure"** for automated Chromium.
- Sites behind bot managers (Akamai Bot Manager, Cloudflare, PerimeterX, etc.) silently re-validate the session on the client side and will bounce a *reused* session (cookies copied into a new browser process) back to the login page, even if the cookie values are technically correct.
- CAPTCHAs, passkeys (WebAuthn), and MFA fundamentally require a human or a registered authenticator — they cannot be scripted.

The fix is a **split-browser architecture**: run a real, visible Chrome on a Sprite, expose it over noVNC so the human can see and click into it from their own device to do the one un-automatable step (login), then have Claude drive that *same, still-running* browser process afterward for the actual automation/scraping. Never close and reopen the browser between login and use — that's what triggers re-validation and kicks the session back to login.

## When to use

- User wants to automate a site that requires Google/Microsoft/SSO login, passkeys, MFA, or a CAPTCHA.
- User hits "this browser may not be secure" or gets silently logged out after Claude reconnects.
- User asks to reuse a previous Sprite/Playwright/noVNC setup, or explicitly names this pattern.

## Prerequisites

- Sprites MCP tools available (`Sprites:*`). If not connected, tell the user this skill needs the Sprites connector.
- A target site URL and, ideally, a known login-detection signal (e.g. a URL pattern like `/account/login` that the site redirects to when unauthenticated).

## Step-by-step workflow

### 1. Pick or create a Sprite

- List sprites (`Sprites:list_sprites`). If the user references "the sprite we used before" or names one, reuse it.
- **If reusing an old sprite that has been used for lots of ad-hoc debugging, check `Sprites:service_list` first.** Old sprites accumulate zombie/auto-restarting services from previous sessions (see `references/troubleshooting.md` — this is the single biggest source of wasted time). If it looks messy (many stopped/failed services, unclear state), it is almost always faster to create a fresh sprite than to untangle it.
- New sprite names **must start with `mcp-`** (e.g. `mcp-<purpose>-browser`).
- `Sprites:exec` and `Sprites:service_logs` are the reliable ways to read output. `service_start`/`service_create`'s own streamed response often comes back empty even when the command worked — **always double check with `cat` over exec or `service_logs` after a short sleep**, don't trust an empty streamed response as "it did nothing."

#### If the sprite is unavailable or broken

A sprite can stop responding or fill up its disk mid-task — the Chrome + Playwright install alone is several hundred MB, and a small sprite disk can genuinely run out of space during `npm install` or `npx playwright install chrome`, which then breaks everything after it (services fail to start, files fail to write, etc.).

Recognize this by: `Sprites:exec` calls hanging or erroring, `service_create`/`service_start` failing outright, or command output containing `ENOSPC` / `No space left on device` / `write failed`.

When you hit this:
1. Retry the failing call once in case it was a transient blip.
2. If it still fails, check `df -h` via `Sprites:exec` (if the sprite responds at all) to confirm it's actually disk space rather than something else.
3. If it's disk space and the sprite still responds to `Sprites:exec`, try `references/cleanup.sh` first — it clears apt/npm/Playwright caches, unused Playwright browser downloads, and Chrome's own cache dirs without touching the login session, and often reclaims enough space on its own. Retry the failing step afterward.
4. If cleanup doesn't help, or the sprite doesn't respond well enough to run it, **stop and tell the user** the sprite looks unavailable/out of space rather than continuing to retry or improvise around it — this is not something to silently paper over.
5. Offer to destroy the broken sprite and provision a fresh one, and explain that this loses any live login session/state on it (they'll need to log in again once the new sprite is up). Only call `Sprites:destroy_sprite` after the user confirms — it's destructive and irreversible.
6. Once confirmed, destroy it, then start over from "Pick or create a Sprite" with a new `mcp-`-prefixed name.

See `references/troubleshooting.md` #7 for more detail.

### 2. Install the environment (once per sprite)

Read `references/install-deps.sh` and run its commands via `Sprites:exec` (not as one long `&&`-chained string — `Sprites:exec`'s `cmd` is NOT shell-parsed, so pipes/redirects/`&&` don't work there; use it for single plain commands, or use `Sprites:service_create` with `cmd: "bash", args: ["-c", "<full script with quotes and heredocs>"]` for anything needing real shell syntax).

In short, this installs:
- `xvfb x11vnc novnc websockify` (virtual display + VNC + noVNC web client)
- Playwright's Node package + **real Google Chrome** via `npx playwright install chrome` and `sudo ... npx playwright install-deps chromium` (system libs) — **do not rely on the bundled Chromium** (`chromium.launch()` default binary); real Chrome is meaningfully less likely to be flagged as automated.
- `sudo` works passwordless on Sprites; when a command needs a specific `PATH` under `sudo`, pass it explicitly (`sudo env PATH=... npx ...`) since `sudo`'s default `PATH` may lack `npx`.
- **Always install with an explicit browser name (`npx playwright install chrome`), never the bare `npx playwright install`** — the bare form silently downloads Chromium, Firefox, *and* WebKit (1GB+ combined) that this skill never uses, which is one of the more common ways a small sprite's disk fills up. See `references/cleanup.sh` if it's already happened.

### 3. Start the display/VNC stack as services

Three long-running services, created in this dependency order (each `needs` the previous):
1. `xvfb` — `Xvfb :99 -screen 0 1280x800x24 -nolisten tcp` (first create `/tmp/.X11-unix` with `sudo mkdir -p` + `sudo chmod 1777` — Xvfb needs this to exist).
2. `x11vnc` — `x11vnc -display :99 -nopw -listen 0.0.0.0 -xkb -forever -shared -rfbport 5900`, `needs: ["xvfb"]`.
3. `novnc` — `websockify --web /usr/share/novnc 6080 localhost:5900`, `needs: ["x11vnc"]`, **`http_port: 6080`** (this is what makes it reachable at the sprite's public URL).

After this, the sprite's URL (`https://<sprite-name>-<id>.sprites.app`) serves noVNC. Give the user this link with the path `/vnc.html?autoconnect=true&resize=scale`:

```
https://<sprite-name>-<id>.sprites.app/vnc.html?autoconnect=true&resize=scale
```

### 4. Write and launch the Playwright script — ONE continuous process

Read `references/playwright-template.js`. Fill in the target URL and (if known) the login-redirect URL fragment used to detect "not logged in". Write it to the sprite with `Sprites:service_create` using a `bash -c "cat > file.js << 'EOF' ... EOF"` heredoc (see step 2 for why), then launch it as its own service with `DISPLAY=:99 node <file>.js`.

**The template's structure is the load-bearing part of this whole skill:**
- Launch via `chromium.launchPersistentContext(userDataDir, { channel: 'chrome', headless: false, ignoreDefaultArgs: ['--enable-automation'], args: [...] })` — real Chrome, automation flag stripped, `--disable-blink-features=AutomationControlled`.
- `--no-sandbox` is required for Chrome to launch inside the sprite, but by itself makes Chrome show an "unsupported command-line flag: --no-sandbox" banner across the top of the window — pair it with `--test-type`, which suppresses that specific banner.
- `context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }))`.
- Navigate to the target URL/dashboard.
- **Poll `page.url()` in a loop** (not `waitForNavigation`, which is fragile across OAuth redirect chains) until it no longer matches the login/OAuth pattern.
- Once logged in, **stay in the same script** — poll again for the actual content to render (SPAs often show a shell page immediately after redirect, then fetch real data async), *then* save `storageState()`, scrape, screenshot.
- Wrap every `page.*` call after login in a `safe()` try/catch helper so a mid-flight navigation (very common right after OAuth callbacks) never throws an uncaught exception — an uncaught exception kills the process, and Sprites services **auto-restart on crash**, which relaunches a fresh Chrome and loses the live session (see pitfall below).
- End with `await new Promise(() => {})` to keep the browser open indefinitely for further use, rather than closing it.

Give the user the noVNC link and ask them to log in. Then poll the log:

```
Sprites:exec  cmd: "cat /.sprite/logs/services/<service-name>.log"
```

repeated with short sleeps, until you see the script's own `LOGIN_DETECTED: true` / content markers.

### 5. After login: keep driving the SAME process

- Do **not** stop and relaunch the browser service to "start fresh" or "clean up" once it's authenticated — this is the #1 way this setup fails. Restarting Chrome (even pointed at the same persistent profile dir, even with `storageState.json` re-injected into a brand new browser instance) frequently gets bounced straight back to the login page by bot-management JS that re-validates the session's continuity/fingerprint on next load. Session cookies and bot-manager tokens (Akamai `_abck`, etc.) are tied to the live TLS/browser-fingerprint session, not just the cookie jar.
- If you need to do more automation after the fact, either:
  - extend the *same* running script to do it (best — requires re-planning what the script does before first launch), or
  - accept that you may need the user to log in again if you do have to restart, and design the next script to do everything (wait-for-login → extract data → keep alive) in one shot so you only need one login.
- `context.storageState({ path: ... })` is still worth saving as a portable backup/audit trail even though reuse across a fresh process isn't reliable for bot-managed sites — it works fine for sites without aggressive bot management.

## Generalizing to a new site

To point this at a new site, you only need to change, in `references/playwright-template.js`:
1. `TARGET_URL` — the page to land on after login (dashboard/home).
2. `LOGIN_URL_MARKER` — a substring that appears in the URL only when NOT logged in (e.g. `/account/login`, `/signin`, `/oauth/authorize`). Used by the polling loop.
3. The content-readiness check (what string/length in `document.body.innerText` means "real content has loaded", not just the SPA shell).
4. Whatever you want extracted (`page.evaluate(...)`) once logged in and settled.

Everything else — Sprite setup, Chrome flags, the noVNC hand-off, the polling pattern, the "never restart mid-session" rule — is site-agnostic and should be reused as-is.

## Critical pitfalls (read before improvising)

See `references/troubleshooting.md` for full detail. Summary:
1. **Sprites services auto-restart on crash/exit**, including ones you thought you stopped, and can even *rewrite files* if an old "write the script" one-shot service gets auto-restarted after you've since overwritten that file — always verify with `Sprites:service_list` if something's behaving unexpectedly, and prefer unique service names per attempt over reusing one name.
2. `Sprites:exec`'s `cmd` field is not shell-parsed — no `&&`, `|`, quoting tricks, or `~` expansion. For anything beyond one plain command, use `Sprites:service_create` with `bash -c "..."`.
3. Streamed tool responses from `service_create`/`service_start` are unreliable for output — always be ready to fall back to `cat <logfile>` via `Sprites:exec` after a short `sleep`.
4. `sudo` on Sprites has a minimal `PATH` — pass `env PATH=...` explicitly when running `npx`/node-based tools under `sudo`.
5. Real Chrome (`channel: 'chrome'`) + stripped automation flags beats bundled Chromium for avoiding "browser may not be secure", but does **not** by itself beat bot-management re-validation on process restart — that requires never restarting between login and use.
6. `page.waitForTimeout` / any `page.*` call can throw if a navigation is in flight (very common right after an OAuth callback) — wrap in try/catch, don't let it kill the process.
7. **Sprites can become unavailable or run out of disk space** (large Playwright/Chrome installs are a common trigger) — don't keep retrying blindly. If the sprite still responds, try `references/cleanup.sh` to reclaim space first. If that doesn't fix it, tell the user and offer to destroy (`Sprites:destroy_sprite`) and recreate the sprite; only do so after they confirm, since it's destructive and discards any live session on it.
