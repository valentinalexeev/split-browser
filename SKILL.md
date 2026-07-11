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

## Hard rule: one-shot actions must never run as a service

`Sprites:service_create` is for **long-running, idempotent processes only** — the display/VNC stack (`xvfb`, `x11vnc`, `novnc`) and the single continuous Playwright driver script (step 4 below). Everything else — filling a field, clicking a button, submitting a form, anything that does something once and is meant to be done — must run via `Sprites:exec`, never `service_create`. No exceptions, including for small throwaway scripts written while iterating on a multi-step flow.

**Why this matters more than it sounds:** Sprites services auto-restart whenever their process exits, *including a normal, successful exit* (see `references/troubleshooting.md` #1). A one-shot script launched as a service doesn't run once — it silently re-runs on every restart, for as long as the service exists. If that script's job was "click Save" or "submit this form," each restart re-clicks Save / re-submits the form against the real, live site. This isn't hypothetical: a one-shot form-submission script was launched via `service_create`, auto-restarted 4 times, and came within one manual check of creating a duplicate real-world record (a duplicate trip booking).

**The pattern to follow, including while debugging:**
- If you need shell features (heredocs, `&&`) just to *write* a script to disk, `service_create` is fine for that — writing a file is idempotent, so re-writing the same content on a restart is harmless.
- **Run** the resulting script with `Sprites:exec cmd: "node <file>.js"` (a single plain command, no shell features needed) — never with a second `service_create`. `Sprites:exec` executes once and is not supervised or restarted.
- Where practical, also make the action itself idempotent (check whether it's already been done before doing it) as a second line of defense in case a script somehow runs more than once anyway.
- If you ever find a side-effecting one-shot script running as a service (yours or left over from a prior session on a reused sprite), stop it immediately, then **verify the actual target system** for duplicated effects before considering things safe — Sprites looking quiet is not proof nothing happened.
- `Sprites:service_stop` is not reliably permanent — a "stopped" service can still come back. Re-check `Sprites:service_list` afterward; if something keeps reappearing and there's no delete tool available, overwrite it via `service_create` (same name) with a harmless no-op command (e.g. `sleep infinity`) to neutralize it for good.

See `references/troubleshooting.md` #9 for the full incident writeup.

## When to use

- User wants to automate a site that requires Google/Microsoft/SSO login, passkeys, MFA, or a CAPTCHA.
- User hits "this browser may not be secure" or gets silently logged out after Claude reconnects.
- User asks to reuse a previous Sprite/Playwright/noVNC setup, or explicitly names this pattern.

**If no login is involved** — just scraping a JS-rendered page behind mild
bot-detection (Qrator, basic UA checks) — skip the whole VNC/display stack
below and read `references/lightweight-no-login.md` instead. It covers a
headless-only Chromium `--only-shell` variant (Firefox was tried and
rejected — see that file for why) with real measured footprint and
OS-specific gotchas. Come back to this main flow only if the lightweight
variant actually gets blocked by something stronger.

## Checkpoint-first workflow (check this before provisioning anything)

Before creating a new sprite and running through install steps, check whether
a checkpointed sprite already exists for the purpose at hand — restoring a
checkpoint takes seconds; a fresh Chrome/Firefox provision takes 1-3 minutes
and re-downloads 100-300 MB every time.

1. Check memory / prior conversation for a sprite name + checkpoint ID matching
   the task (login-flow browser vs. headless Chromium-shell). Anthropic's
   memory system is the source of truth here, since `Sprites:list_sprites`
   has been observed returning an empty list while `Sprites:create_sprite`
   simultaneously reports the account's sprite quota as full — the API's
   listing is not reliable, don't trust an empty result as "no sprites exist."
2. If a matching sprite+checkpoint is known, restore it (`Sprites:checkpoint_restore`)
   instead of provisioning from scratch.
3. Only provision a new sprite when no suitable checkpoint exists, or the
   checkpointed one no longer responds (see "If the sprite is unavailable or
   broken" above — try that recovery path first, including on a checkpoint
   restore that comes back wedged).
4. After any successful provisioning + cleanup, immediately
   `Sprites:checkpoint_create` with a comment describing what's installed and
   how to launch it (browser variant, launch args, NODE_PATH if relevant).
   Then record the sprite name, purpose, and checkpoint ID somewhere durable
   (ask the person if it should go into Claude's memory) so the next session
   can skip straight to step 2 instead of rediscovering this from scratch.

`Sprites:checkpoint_restore` restores a checkpoint onto the *same* sprite it
was created on — there is no "spin up a new sprite from this checkpoint"
operation. That makes long-lived, purpose-named sprites (not one-off names
per task) the right pattern here: keep `mcp-scrape-chromium` and a
login-capable `mcp-<site>-browser` around and restore/reuse them, rather than
creating and destroying a fresh sprite per conversation.

## Prerequisites

- Sprites MCP tools available (`Sprites:*`). If not connected, tell the user this skill needs the Sprites connector.
- A target site URL and, ideally, a known login-detection signal (e.g. a URL pattern like `/account/login` that the site redirects to when unauthenticated).

## Step-by-step workflow

### 1. Pick or create a Sprite

- List sprites (`Sprites:list_sprites`). If the user references "the sprite we used before" or names one, reuse it.
- **If reusing an old sprite that has been used for lots of ad-hoc debugging, check `Sprites:service_list` first.** Old sprites accumulate zombie/auto-restarting services from previous sessions (see `references/troubleshooting.md` — this is the single biggest source of wasted time). Pay special attention to any zombie service whose command performs a real action on the target site rather than just reading local files — that's not harmless clutter, it's a live risk of repeating that action (see the hard rule above). If it looks messy (many stopped/failed services, unclear state), it is almost always faster to create a fresh sprite than to untangle it.
- **Do this state check once per sprite, not once per step.** `list_sprites` / `service_list` are only needed here (picking/validating the sprite) and after install (confirming services came up). Once you know the sprite's state, hold onto that within the conversation rather than re-querying it before every subsequent action — repeated status checks are a common source of burning through the tool-call budget on a task that otherwise needs relatively few calls.
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

Read `references/install-deps.sh`. **Do not run its commands one by one via separate `Sprites:exec` calls** — that burns a tool call per line. Instead, wrap the whole install sequence into a single `Sprites:service_create` call with `cmd: "bash", args: ["-c", "<full script, using && between steps, with quotes and heredocs as needed>"]` (a one-shot script launched this way is fine per the Hard Rule above, since writing/installing is idempotent — just don't re-launch it as a *second* service afterward). Follow up with one `Sprites:exec cat <logfile>` after a short sleep to confirm it finished, instead of checking after every individual step.

In short, this installs:
- `xvfb x11vnc novnc websockify` (virtual display + VNC + noVNC web client)
- Playwright's Node package + **real Google Chrome** via `npx playwright install chrome` and `sudo ... npx playwright install-deps chromium` (system libs) — **do not rely on the bundled Chromium** (`chromium.launch()` default binary); real Chrome is meaningfully less likely to be flagged as automated.
- `sudo` works passwordless on Sprites; when a command needs a specific `PATH` under `sudo`, pass it explicitly (`sudo env PATH=... npx ...`) since `sudo`'s default `PATH` may lack `npx`.
- **Always install with an explicit browser name (`npx playwright install chrome`), never the bare `npx playwright install`** — the bare form silently downloads Chromium, Firefox, *and* WebKit (1GB+ combined) that this skill never uses, which is one of the more common ways a small sprite's disk fills up. See `references/cleanup.sh` if it's already happened.
- **Run the cleanup step (step 6 in `references/install-deps.sh`) immediately after install, every time, not just when disk space becomes a problem.** It drops apt's `.deb` archives and package lists, clears the npm cache, and removes any unused Chromium/Firefox/WebKit downloads — all safe before any login/profile exists. Treat this as part of installation, not a separate troubleshooting step reserved for when a sprite is already broken.

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

> **Tool-call budget note:** plan the *entire* post-login sequence before writing this file, not just the login-detection part. Each time the script has to be rewritten via a fresh heredoc (because a later step was forgotten) costs a full `service_create` call plus a relaunch. Likewise, if the task involves many post-login steps on the site (several clicks/fields/pages), write that whole sequence into this one script now — inside the `safe()`-wrapped block after login — rather than planning to drive it step-by-step with separate `Sprites:exec`/CDP calls later. One well-planned script beats many small follow-up calls.

**The template's structure is the load-bearing part of this whole skill:**
- Launch via `chromium.launchPersistentContext(userDataDir, { channel: 'chrome', headless: false, ignoreDefaultArgs: ['--enable-automation'], args: [...] })` — real Chrome, automation flag stripped, `--disable-blink-features=AutomationControlled`.
- `--no-sandbox` is required for Chrome to launch inside the sprite, but by itself makes Chrome show an "unsupported command-line flag: --no-sandbox" banner across the top of the window — pair it with `--test-type`, which suppresses that specific banner.
- `context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }))`.
- Navigate to the target URL/dashboard.
- **Poll `page.url()` in a loop** (not `waitForNavigation`, which is fragile across OAuth redirect chains) until it no longer matches the login/OAuth pattern.
- Once logged in, **stay in the same script** — poll again for the actual content to render (SPAs often show a shell page immediately after redirect, then fetch real data async), *then* save `storageState()`, scrape, screenshot.
- If the task needs a write/side-effecting action (clicking Save, submitting a form, etc.), perform it here, inside this same running script — never as a separately launched one-shot service. See "Hard rule" above for why.
- Wrap every `page.*` call after login in a `safe()` try/catch helper so a mid-flight navigation (very common right after OAuth callbacks) never throws an uncaught exception — an uncaught exception kills the process, and Sprites services **auto-restart on crash**, which relaunches a fresh Chrome and loses the live session (see pitfall below).
- End with `await new Promise(() => {})` to keep the browser open indefinitely for further use, rather than closing it.

Give the user the noVNC link and ask them to log in. Then poll the log — **but do the waiting inside a single `Sprites:exec` call, not as many separate calls with short sleeps in between.** Calling `exec` once every 2-3 seconds to `cat` the log burns a tool call per check and can easily reach 20-40 calls while waiting for a human to complete a login. Instead, use one call that loops and sleeps internally, returning as soon as the marker appears (or on timeout):

```
Sprites:exec  cmd: "bash -c 'for i in $(seq 1 20); do grep -q LOGIN_DETECTED /.sprite/logs/services/<service-name>.log 2>/dev/null && break; pgrep -f \"node <file>.js\" >/dev/null || break; sleep 5; done; tail -c 2000 /.sprite/logs/services/<service-name>.log'"
```

This bundles ~100 seconds of waiting (20 × 5s — tune to how long login realistically takes) into one call instead of ~20-40 separate ones. The `pgrep` check is a second exit condition: if the launcher process has died (e.g. an uncaught exception, see pitfall #6), the loop breaks immediately instead of sleeping out the full timeout for nothing — check the tail output for whether it ended on the marker, a dead process, or a plain timeout, and act accordingly (marker → proceed; dead process → the service likely auto-restarted, a fresh login may be needed; timeout → call again to keep waiting). If the marker still hasn't appeared after one call, just issue the same call again rather than switching to short-interval polling.

### 5. After login: keep driving the SAME process

- Do **not** stop and relaunch the browser service to "start fresh" or "clean up" once it's authenticated — this is the #1 way this setup fails. Restarting Chrome (even pointed at the same persistent profile dir, even with `storageState.json` re-injected into a brand new browser instance) frequently gets bounced straight back to the login page by bot-management JS that re-validates the session's continuity/fingerprint on next load. Session cookies and bot-manager tokens (Akamai `_abck`, etc.) are tied to the live TLS/browser-fingerprint session, not just the cookie jar.
- For anything that comes up **later in the conversation** — a different page, a follow-up lookup, "check X again" — the preferred option is the CDP control-script pattern: see "Driving the browser again later in the conversation" below. It opens a new tab in the same authenticated context without touching the running launcher process at all.
- The other two options from before still apply when the control-script pattern doesn't fit:
  - extend the *same* running launcher script to do more (best when you can plan the full task before first launch), or
  - accept that you may need the user to log in again if you do have to restart, and design the next script to do everything (wait-for-login → extract data → keep alive) in one shot so you only need one login.
- `context.storageState({ path: ... })` is still worth saving as a portable backup/audit trail even though reuse across a fresh process isn't reliable for bot-managed sites — it works fine for sites without aggressive bot management.

## Generalizing to a new site

To point this at a new site, you only need to change, in `references/playwright-template.js`:
1. `TARGET_URL` — the page to land on after login (dashboard/home).
2. `LOGIN_URL_MARKER` — a substring that appears in the URL only when NOT logged in (e.g. `/account/login`, `/signin`, `/oauth/authorize`). Used by the polling loop.
3. The content-readiness check (what string/length in `document.body.innerText` means "real content has loaded", not just the SPA shell).
4. Whatever you want extracted (`page.evaluate(...)`) once logged in and settled.
5. `CDP_PORT` — only if running more than one login-browser on the same sprite; otherwise leave at 9222.

Everything else — Sprite setup, Chrome flags, the noVNC hand-off, the polling pattern, the "never restart mid-session" rule — is site-agnostic and should be reused as-is.

## Driving the browser again later in the conversation — without restarting it

Once the launcher (`playwright-template.js`) is sitting in `KEEP_ALIVE`, don't
write a second heredoc'd script to check something else, and don't restart
the launcher to "start fresh" — both risk exactly the bot-management
re-validation this whole skill exists to avoid, and a heredoc rewrite also
costs tokens for no reason once the browser is already up.

Instead, use `references/login-control-template.js`: a small script that
attaches to the *existing* browser over CDP (`chromium.connectOverCDP`),
grabs the *existing* authenticated context (`browser.contexts()[0]` — do NOT
create a new context here, unlike the no-login lightweight variant, since a
fresh context has no session), opens a new tab, does one navigation +
extraction, and closes only that tab. Write it once, then every follow-up
lookup for the rest of the conversation is a single plain
`Sprites:exec cmd: "node login-control-template.js <url>"` call — no heredoc,
no risk to the live session.

This mirrors the launcher/control split documented in
`references/lightweight-no-login.md` for the no-login case; the difference
is entirely in what the control script does with the context (reuse vs.
create fresh) — see that file's header comment for why.

## Critical pitfalls (read before improvising)

See `references/troubleshooting.md` for full detail. Summary:
1. **Sprites services auto-restart on crash/exit**, including ones you thought you stopped, and can even *rewrite files* if an old "write the script" one-shot service gets auto-restarted after you've since overwritten that file — always verify with `Sprites:service_list` if something's behaving unexpectedly, and prefer unique service names per attempt over reusing one name.
2. `Sprites:exec`'s `cmd` field is not shell-parsed — no `&&`, `|`, quoting tricks, or `~` expansion. For anything beyond one plain command, use `Sprites:service_create` with `bash -c "..."`.
3. Streamed tool responses from `service_create`/`service_start` are unreliable for output — always be ready to fall back to `cat <logfile>` via `Sprites:exec` after a short `sleep`.
4. `sudo` on Sprites has a minimal `PATH` — pass `env PATH=...` explicitly when running `npx`/node-based tools under `sudo`.
5. Real Chrome (`channel: 'chrome'`) + stripped automation flags beats bundled Chromium for avoiding "browser may not be secure", but does **not** by itself beat bot-management re-validation on process restart — that requires never restarting between login and use.
6. `page.waitForTimeout` / any `page.*` call can throw if a navigation is in flight (very common right after an OAuth callback) — wrap in try/catch, don't let it kill the process.
7. **Sprites can become unavailable or run out of disk space** (large Playwright/Chrome installs are a common trigger) — don't keep retrying blindly. If the sprite still responds, try `references/cleanup.sh` to reclaim space first. If that doesn't fix it, tell the user and offer to destroy (`Sprites:destroy_sprite`) and recreate the sprite; only do so after they confirm, since it's destructive and discards any live session on it.
8. **Never launch a one-shot, side-effecting action (Save/Submit/Buy/Delete, form submissions) via `service_create`** — only via `Sprites:exec`. A one-shot script launched as a service gets silently re-run on every auto-restart, which can repeat a real write against the live site. `Sprites:service_stop` is also not reliably permanent — verify with `Sprites:service_list` afterward and overwrite with a no-op command if something keeps reappearing. See the "Hard rule" section above and `references/troubleshooting.md` #9.
