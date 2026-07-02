# split-browser

A Claude Code skill for automating websites that require a human login step (Google/Microsoft/SSO, MFA, passkeys, CAPTCHA) which Claude cannot complete on its own.

## What it does

Many sites can't be logged into by a fully automated Playwright browser: "Sign in with Google"-style flows flag automated Chromium as insecure, bot managers (Akamai, Cloudflare, PerimeterX) re-validate sessions on the client side and bounce reused cookies back to the login page, and CAPTCHAs/passkeys/MFA fundamentally need a human or a registered authenticator.

This skill sets up a **split-browser architecture** to work around that:

1. Launch a real, visible Chrome on a cloud sandbox ([Sprites.dev](https://sprites.dev)), exposed over noVNC.
2. A human opens the noVNC link and manually performs the one un-automatable step (login).
3. Claude then drives that *same, still-running* Chrome process via Playwright to navigate, scrape, or automate the site — without ever closing and reopening the browser, which is what triggers bot-management re-validation and kicks the session back to login.

## Contents

- [`SKILL.md`](SKILL.md) — the skill definition: when to trigger it and the full step-by-step workflow (provisioning the sandbox, installing dependencies, starting the Xvfb/x11vnc/noVNC stack, writing and launching the Playwright script, handing off to the human, and driving the browser afterward).
- [`references/playwright-template.js`](references/playwright-template.js) — a crash-resistant Playwright script template: launches real Chrome with automation flags stripped, waits for human login, polls for real content (not just an SPA shell), saves session state, and stays alive indefinitely.
- [`references/install-deps.sh`](references/install-deps.sh) — the tested sequence of setup commands for a fresh sandbox (Xvfb, x11vnc, noVNC, websockify, Node, Playwright, real Chrome, and its system dependencies).
- [`references/troubleshooting.md`](references/troubleshooting.md) — detailed write-ups of the pitfalls that make or break this approach, most importantly: sandbox services auto-restart on crash and can silently wipe out live sessions or overwrite files, and bot-management cookies are tied to a *live* browser session, not just cookie values, so restarting the browser after login almost always loses the session.

## Usage

This is packaged as a Claude Code skill (`SKILL.md` + `references/`). Load it into an environment with Claude Code and access to the Sprites MCP connector; it will trigger automatically when you ask Claude to automate a site that requires a human-only login step.
