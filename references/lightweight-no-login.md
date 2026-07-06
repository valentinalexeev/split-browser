# Lightweight variant: scraping without a login step

The full split-browser flow (real Chrome + Xvfb + noVNC + human login) exists
to solve ONE problem: a human has to complete a step (Google/Microsoft SSO,
CAPTCHA, MFA) that can't be scripted. If the target page needs no login and
you're just fighting basic bot-detection (Qrator, simple UA/JS checks) or a
JS-rendered SPA, that whole VNC/display stack is unnecessary overhead — skip
straight to a headless browser on a Sprite, no display server, no human.

## Chromium headless-shell (`--only-shell`)

Smallest, fastest option when the target site's bot-detection is mild (UA
string + basic fingerprint checks). This is what we used successfully against
Qrator-protected pulkovoairport.ru.

```
mkdir -p /home/sprite/pw && cd /home/sprite/pw && npm init -y
npm install playwright
npx playwright install chromium --only-shell
sudo env PATH=/home/sprite/.local/bin:/.sprite/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npx playwright install-deps chromium
sudo apt-get clean && sudo rm -rf /var/lib/apt/lists/*
npm cache clean --force
rm -rf ~/.cache/ms-playwright/chromium-[0-9]*   # full headed build, not needed
rm -rf ~/.cache/ms-playwright/firefox-* ~/.cache/ms-playwright/webkit-* ~/.cache/ms-playwright/ffmpeg-*
```

Launch code:
```js
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
```

For a bit more stealth against slightly stricter bot-detection, set a real
UA/locale/viewport on the context and strip the automation flag, same trick
as the full split-browser template:
```js
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  locale: 'ru-RU', viewport: { width: 1366, height: 768 }
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
```
This combination (headless-shell + spoofed UA/context) was enough to get past
Qrator on the first real try.

Measured footprint on a fresh `questing` sprite: ~114 MB browser download +
~55 MB apt deps (fonts/X11/audio libs Chrome always wants, headless or not) ≈
**~170 MB total**, node_modules ~18 MB on top.

## Firefox — evaluated and rejected, don't retry without reason

A Firefox variant was tried as a lighter alternative and abandoned: its
browser download (~105 MB) is smaller than Chrome's, but on Ubuntu `questing`
its runtime dependency `libgtk-3-0t64` drags in `dbus`, `dbus-user-session`,
`libpam-systemd`, and all of `systemd` as transitive deps — even with
`apt-get install --no-install-recommends`. End result: total footprint ends
up **the same ballpark as the Chromium variant, not lighter**, for extra
setup complexity (`npx playwright install-deps firefox` also fails outright
on this Ubuntu release with `libavcodec60 has no installation candidate`,
requiring a manual package list instead). Not worth it here — use Chromium
`--only-shell` above unless a specific site's bot-detection is shown to
specifically flag Chromium's fingerprint (rare).

## Launcher/control split — cuts per-call token cost

Each `Sprites:exec` call that includes a full inline Playwright script (via
heredoc) resends that entire script through the conversation every time,
which adds up over a session that does many scrapes. Split into two files,
written once:

- **`launcher.js`** — launches the browser once with a CDP port exposed
  (`args: ['--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1']`),
  then `await new Promise(() => {})` to stay alive forever. Run this via
  `Sprites:service_create` (long-running, legitimate — this is not a one-shot
  side-effecting action, it's the "browser window" itself).
- **`control.js`** — takes a URL as `argv[2]`, connects via
  `chromium.connectOverCDP('http://127.0.0.1:9222')`, **always creates a
  fresh `browser.newContext(...)`** with the stealth UA/locale/webdriver-hide
  settings (see below for why), does one navigation + text extraction, prints
  it, and closes only its own context/CDP connection — never `browser.close()`
  in a way that kills the shared launcher process (connecting via CDP and
  calling `.close()` on the connection object only disconnects; it doesn't
  kill the launcher's browser).

After that, each actual scrape is just:
```
Sprites:exec cmd: "node /home/sprite/pw/control.js https://example.com/page"
```
One line, no script body in the call — that's the token saving.

**Pitfall hit on first try:** `browser.contexts()[0]` (the launcher's default
context) has no stealth settings applied — it's the plain automated context,
`navigator.webdriver` is `true`, and Qrator blocked it immediately. Always
create a **new** context per `control.js` call with the UA/locale/webdriver
overrides; don't reuse the launcher's default one.

## Checkpoints only save the filesystem, not running processes

Confirmed: a Sprites checkpoint captures disk state (the written `.js`
files, node_modules, apt packages) but **not** the live `browser-launcher`
service. After `Sprites:checkpoint_restore`, the launcher process is not
running — check with `Sprites:service_list` and re-start it explicitly
(`Sprites:service_start browser-launcher`, or `service_create` again if the
definition itself didn't survive) before the first `control.js` call.
Build this check into the workflow rather than assuming a restored
checkpoint is immediately ready to drive.

## When to use which

- **Chromium `--only-shell`**: the default and, per the above, the only
  no-login variant currently kept provisioned.
- **Neither, use full split-browser (real Chrome + VNC)**: if the target
  needs an actual login step (Google/Microsoft SSO, MFA, CAPTCHA). Bot
  managers on those flows are tuned against Chromium-family traffic
  specifically.

## Hard rule still applies

Everything in "Hard rule: one-shot actions must never run as a service" at
the top of SKILL.md applies here too — provisioning (writing files, apt
install, npm install) is fine via `service_create` since it's idempotent; the
actual scrape/action script must run via `Sprites:exec`, one shot.

**Corollary learned the hard way:** if a provisioning script uses `set -e`
and one command in it fails, the whole service exits non-zero — which means
Sprites auto-restarts it, which re-runs the *entire* script including the
parts that already succeeded (re-downloading the browser, etc.), forever,
until you notice. Two symptoms to watch for: `restart_count` climbing in
`Sprites:service_list`, and `dpkg`/`apt` lock errors from two copies of the
same install running concurrently. Fix is `Sprites:service_stop` immediately;
if that 409s ("not running") because it's mid-restart-backoff, retry once —
if it still won't stop, `Sprites:destroy_sprite` and re-provision is faster
and safer than fighting a wedged service. Consider dropping `set -e` from
purely-provisioning scripts, or checking exit codes command-by-command
instead of aborting the whole script on the first failure.

## Checkpoint immediately after provisioning

Once cleaned and working, `Sprites:checkpoint_create` before running any real
task. This is the actual fix for "installation takes forever" — not shrinking
the install further, but never repeating it. See "Checkpoint-first workflow"
in SKILL.md.
