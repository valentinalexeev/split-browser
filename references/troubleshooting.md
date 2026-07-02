# Troubleshooting

Detailed version of the pitfalls summarized in SKILL.md, with the actual
symptoms so you recognize them quickly.

## 1. Sprites services auto-restart, and this causes real damage

Services created with `Sprites:service_create` restart automatically when
their process exits or is killed — including with a non-zero exit code, and
including after you `pkill`'d the process yourself expecting it to just die.

Observed failure modes:
- A one-shot "write this file via heredoc" service, run once and forgotten,
  gets auto-restarted much later (e.g. triggered by an unrelated `pkill -9`
  elsewhere on the box) and **silently overwrites a file you'd since edited**,
  reverting your script to an old version without any error.
- A crashed Playwright script (uncaught exception → `process.exit(1)`) respawns
  a brand new Chrome process on the same profile dir, which — combined with
  pitfall #5 below — loses the live authenticated session even though the
  disk-persisted profile still has *some* cookies.
- Two Chrome processes end up pointed at the same `--user-data-dir`
  simultaneously (one old zombie + one freshly launched), which can leave the
  profile's cookie DB in an inconsistent state.

**Mitigations:**
- Use a fresh, unique `service_name` for each real attempt (`pw-nav`,
  `pw-nav2`, `pw-final3`, ...) rather than reusing one name across edits —
  makes it obvious in `Sprites:service_list` which one is actually current.
- Before doing anything destructive (`pkill`, `rm -rf` a profile dir), check
  `Sprites:service_list` for what's *supposed* to be running and explicitly
  `Sprites:service_stop` each one first.
- Never let your own script crash (see pitfall #6) — that's the trigger you
  actually control.
- If a sprite has accumulated a lot of one-off debugging services, it is
  usually faster to spin up a fresh sprite (`mcp-` prefix required) than to
  fully untangle it.

## 2. `Sprites:exec`'s `cmd` is not shell-parsed

`Sprites:exec cmd: "bash -c 'echo hi && echo bye'"` does **not** work — it
gets split naively and fails with quoting errors, or silently no-ops. Simple
commands like `cmd: "echo hi"`, `cmd: "node -v"`, `cmd: "sudo apt-get update"`
work fine because they need no shell features.

For anything needing `&&`, pipes, redirection, or heredocs, use
`Sprites:service_create` with `cmd: "bash", args: ["-c", "<full script>"]` —
that path *does* go through a real shell.

## 3. Streamed responses from `service_create`/`service_start` are not reliable

Calling `service_create`/`service_start` with a `duration` returns a stream of
NDJSON events, but in practice this often comes back as just
`{"type":"started"...} {"type":"complete"...}` with **no stdout/stderr lines
at all**, even when the underlying command produced plenty of output and
succeeded. Don't treat an empty stream as "nothing happened" or "it failed."

**Always verify separately:**
```
Sprites:exec cmd: "cat /.sprite/logs/services/<service-name>.log"
```
after a short `sleep` (via another `Sprites:exec cmd: "sleep 5"` call, since
Claude has no local `sleep`/wait primitive). `Sprites:service_logs` can also
work but has shown the same "comes back empty even though there's content"
behavior in the same session — `cat` over `exec` has been the most reliable.

## 4. `sudo`'s PATH is minimal

`sudo npx playwright install-deps chromium` → `sudo: npx: command not found`,
even though `npx` works fine unprivileged. Fix: pass PATH explicitly,
e.g. `sudo env PATH=/home/sprite/.local/bin:/.sprite/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx ...`
(check `which npx` first to get the real path components on that sprite).

## 5. Bot-management re-validates sessions on browser process restart

This is the core "gotcha" of the whole approach, worth over-explaining:

Sites protected by Akamai Bot Manager (and similar — Cloudflare, PerimeterX)
set cookies (e.g. `_abck`, `bm_sv`, `bm_sz` for Akamai) that are tied to a
*live* browser/TLS fingerprint session, not just to the cookie *values*.
Symptoms actually observed:
- Login succeeds, `page.url()` correctly shows the logged-in dashboard.
- Stop the browser service, restart it pointed at the **same persistent
  profile directory** (same cookies on disk) → immediately after
  `page.goto()`, it briefly shows logged in, but within a few seconds of
  the SPA's background API calls, it silently redirects back to the login
  page.
- Exporting `context.storageState()` and injecting those exact cookies into
  a **brand new** `browser.newContext({ storageState: ... })` (even a fresh
  real-Chrome instance) → immediately redirected to login. Cookie values
  alone are not sufcient.

**The only reliable pattern found:** do the entire login-wait → confirm →
extract sequence in one continuous script execution, in the same Chrome
process the whole time, and never close/restart it in between. Treat the
live browser window as a stateful resource you hand off to the human once,
not as something you tear down and recreate.

If you genuinely need multi-day persistence beyond a single session, the
practical answer is not cookie/storageState replay — it's registering a
resident WebAuthn passkey for that Chrome profile (via
`CDP WebAuthn.addVirtualAuthenticator`) so future logins in that *same*
profile can authenticate without a human, though this still doesn't fully
sidestep bot-management re-validation on its own; it only removes the
human-input requirement, not the "don't restart Chrome" requirement.

## 6. Uncaught exceptions mid-script are common right after OAuth callbacks

`page.evaluate(...)` and similar right after a redirect can throw
`Execution context was destroyed, most likely because of a navigation` — this
is normal, not a bug, because the OAuth callback chain triggers several
navigations in quick succession. Left uncaught, this exception propagates,
the script's outer `.catch()` calls (or previously called) `process.exit(1)`,
and the Sprites service auto-restart (pitfall #1) then loses your live
session. Wrap every post-login `page.*` call in the `safe()` helper from the
template.

## 7. The sprite itself can become unavailable or run out of disk space

A sprite is a real VM with a finite disk, and this setup installs several
hundred MB onto it (Node modules, real Chrome, Chrome's system deps via
`playwright install-deps`). On a small sprite, or one that's accumulated
multiple Chrome/Node installs across debugging attempts, this can genuinely
fill the disk. Separately, a sprite can also just stop responding for
unrelated infra reasons.

Observed symptoms:
- `Sprites:exec` calls hang indefinitely or return an error instead of
  output.
- `Sprites:service_create` / `Sprites:service_start` fail to bring services
  up, or the services immediately crash-loop.
- Command output (from `npm install`, `npx playwright install chrome`, or
  even simple file writes) contains `ENOSPC`, `No space left on device`, or
  `write failed`.
- `Xvfb`/`x11vnc`/`novnc` services that were previously healthy start
  failing to (re)start with no clear application-level error — worth
  checking disk space even if the error message doesn't mention it.

**What to do — do not thrash on this:**
1. Retry the one failing call once, in case it's a transient blip rather
   than the sprite actually being broken.
2. If the sprite still responds at all, run `df -h` via `Sprites:exec` to
   confirm disk space is actually the cause (vs. e.g. a crash-looping
   service from pitfall #1).
3. If it's confirmed (or the sprite doesn't respond well enough to check),
   **stop and tell the user** plainly what's going on — don't keep retrying
   installs or improvising cleanup commands hoping it resolves itself.
4. Offer the user a choice: destroy the sprite and provision a fresh one
   (via `Sprites:destroy_sprite` then a new `Sprites:create_sprite` /
   `mcp-`-prefixed sprite), or try to reclaim space in place (e.g. clearing
   npm/apt caches) if they'd rather keep the current sprite and any state
   on it. Destroying is usually faster and is the more reliable fix, but it
   **discards any live login session** on that sprite, so don't do it
   without the user's explicit go-ahead.
5. After destroying and recreating, redo the environment install
   (`references/install-deps.sh`) and the display/VNC services from
   scratch, and let the user know they'll need to log in again — there is
   no session to carry over from a destroyed sprite.

## 8. "Unsupported command-line flag: --no-sandbox" banner

Chrome shows a banner across the top of the window reading "You are using
an unsupported command-line flag: --no-sandbox. Stability and security will
suffer." whenever it's launched with `--no-sandbox` on its own. `--no-sandbox`
is required here because the sprite's container environment doesn't support
Chrome's own setuid/namespace sandbox, so this banner would show on every
launch by default.

It's visible to the human over noVNC (distracting, and can read as
suspicious/unprofessional if this is ever shown to someone unfamiliar with
the setup) and it also shifts the page content down, which can throw off
fixed pixel-offset assumptions in scraping/screenshot code.

**Fix:** add `--test-type` alongside `--no-sandbox` in the launch `args` —
it's a Chromium flag that specifically suppresses this "bad flags" banner.
It's already in `references/playwright-template.js`; if you hand-roll a
launch config instead of using the template, don't drop it.
