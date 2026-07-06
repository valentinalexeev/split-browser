// Generic "control" script for an ALREADY-RUNNING, ALREADY-LOGGED-IN
// login-flow browser (the one launched from playwright-template.js with
// CDP_PORT exposed). Use this for anything that comes up later in the same
// conversation — a different page, a follow-up lookup — instead of writing
// a fresh heredoc'd script each time or, worse, restarting the launcher.
//
// Usage: node login-control-template.js '<url>' [cdp_port]
//   node login-control-template.js https://www.tripit.com/app/trips
//   node login-control-template.js https://example.com/other-page 9223
//
// Run via Sprites:exec (one shot, never service_create — see the "Hard
// rule" in SKILL.md). No heredoc needed once this file exists on the
// sprite; each call is a single plain command.
//
// CRITICAL DIFFERENCE from the no-login lightweight variant
// (references/lightweight-no-login.md): that pattern always creates a
// FRESH context per call, because there's no session to preserve and a
// fresh stealth context is what avoids bot-detection. Here it's the exact
// opposite — the whole point is the EXISTING context's cookies/session.
// Grabbing `browser.contexts()[0]` (the one and only context
// launchPersistentContext created) is correct and required; creating a new
// context here would just get you a logged-out browser.

// Confirmed working in practice (2026-07-06, TripIt): connectOverCDP against
// a launchPersistentContext browser launched with --remote-debugging-port
// works fine, despite Playwright also using its own --remote-debugging-pipe
// internally for the launcher process — the two don't conflict.
//
// One real gotcha hit during testing: if a Sprites:exec call to run this
// script times out client-side (transport timeout), don't immediately retry
// — the underlying node process may still be running server-side and will
// finish on its own. Firing a second overlapping call before confirming the
// first one actually died just piles up extra tabs/processes. Check with a
// quick `ps aux` (look for orphaned `node login-control...` or extra Chrome
// `--type=renderer` processes) before retrying, and only `kill` a process
// you've confirmed is truly stuck (e.g. it's been running several minutes
// with no CPU activity), not just one that made a slow tool call time out.

const { chromium } = require('playwright');

async function safe(fn, fallback) {
  try { return await fn(); } catch (e) { console.log('SAFE_CATCH:', e.message); return fallback; }
}

(async () => {
  const url = process.argv[2];
  const cdpPort = process.argv[3] || 9222;
  if (!url) { console.error('Usage: node login-control-template.js <url> [cdp_port]'); process.exit(1); }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const context = browser.contexts()[0]; // the authenticated persistent context — do NOT create a new one
  if (!context) {
    console.error('NO_CONTEXT_FOUND — is the launcher actually running on this port?');
    process.exit(1);
  }

  // Open a NEW TAB rather than reusing/navigating an existing one, so
  // whatever the human (or a prior action) had open stays untouched.
  const page = await context.newPage();
  try {
    await safe(() => page.goto(url, { timeout: 20000, waitUntil: 'domcontentloaded' }));
    await safe(() => page.waitForTimeout(4000));
    const text = await safe(() => page.evaluate(() => document.body.innerText), '');
    console.log('URL:', page.url());
    console.log('TITLE:', await safe(() => page.title(), 'N/A'));
    console.log('BODY_TEXT_START');
    console.log(text);
    console.log('BODY_TEXT_END');
  } finally {
    // Close only the tab this call opened. Do NOT call browser.close() in
    // a way that tears down the shared connection carelessly — for
    // connectOverCDP, browser.close() ends this CDP session/client only,
    // it does not kill the launcher's actual Chrome process or its other
    // tabs. Still, closing the page we opened keeps the window tidy across
    // repeated calls in a long conversation.
    await safe(() => page.close());
  }
})();
