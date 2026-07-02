// Template for a single, continuous, crash-resistant browser session:
// launch -> wait for human to log in via noVNC -> wait for real content to
// render -> save state + extract -> stay alive.
//
// Fill in the four placeholders marked with {{ }} before writing this to
// the sprite. Everything else should generally be left as-is; it encodes
// lessons learned the hard way (see references/troubleshooting.md).
//
// Write this to the sprite with a heredoc via Sprites:service_create
// (bash -c "cat > /home/sprite/pw/<name>.js << 'EOF' ... EOF"), then run it
// with its own Sprites:service_create: cmd="bash",
// args=["-c","DISPLAY=:99 node /home/sprite/pw/<name>.js"], needs=["xvfb"].

const { chromium } = require('playwright');

// Never let a single failed page.* call kill the whole process — a crash
// triggers Sprites' service auto-restart, which relaunches Chrome and loses
// the live, already-authenticated session. That is the single most common
// way this whole approach fails.
async function safe(fn, fallback) {
  try { return await fn(); } catch (e) { console.log('SAFE_CATCH:', e.message); return fallback; }
}

const TARGET_URL = '{{TARGET_URL}}';           // e.g. 'https://www.example.com/app/dashboard'
const LOGIN_URL_MARKER = '{{LOGIN_URL_MARKER}}'; // substring only present in the URL when logged OUT, e.g. '/account/login'
const MIN_CONTENT_LEN = 300;                    // tune per site: how long body.innerText is once real content (not just the SPA shell) has loaded

(async () => {
  const userDataDir = '/home/sprite/pw/chrome-profile';
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      // --no-sandbox on its own makes Chrome show a "You are using an
      // unsupported command-line flag: --no-sandbox" banner across the top
      // of the window (visible to the human over noVNC, and it shifts page
      // layout under it). --test-type suppresses that specific banner.
      '--test-type',
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
      '--window-position=0,0',
      '--window-size=1280,800',
      '--disable-infobars',
    ],
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = context.pages()[0] || (await context.newPage());
  await safe(() => page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }));

  console.log('WAITING_FOR_LOGIN');
  let loggedIn = false;
  for (let i = 0; i < 300; i++) { // up to 10 minutes
    await safe(() => page.waitForTimeout(2000));
    const url = page.url();
    if (url && !url.includes(LOGIN_URL_MARKER) && !url.includes('accounts.google.com')) {
      loggedIn = true;
      break;
    }
  }
  console.log('LOGIN_DETECTED:', loggedIn);
  if (!loggedIn) {
    console.log('TIMEOUT_NO_LOGIN');
    await new Promise(() => {}); // stay alive so the human can retry without losing the window
    return;
  }

  // SPAs often render a shell immediately after the OAuth redirect and fetch
  // real content async — poll body text length rather than trusting the
  // first snapshot right after the URL changes.
  let stillOk = true;
  let bodyText = '';
  for (let i = 0; i < 20; i++) {
    await safe(() => page.waitForTimeout(1500));
    const u = page.url();
    if (u.includes(LOGIN_URL_MARKER)) { stillOk = false; console.log('BOUNCED_TO_LOGIN_AT_POLL', i); break; }
    bodyText = await safe(() => page.evaluate(() => document.body.innerText), '');
    if (bodyText && bodyText.length > MIN_CONTENT_LEN) { console.log('CONTENT_READY_AT_POLL', i); break; }
  }
  console.log('STILL_OK:', stillOk);
  console.log('URL:', page.url());
  console.log('TITLE:', await safe(() => page.title(), 'N/A'));

  // Portable backup — reliable to reuse for sites without aggressive bot
  // management; not guaranteed to survive a process restart on sites that
  // re-validate session/browser fingerprint continuity (see troubleshooting.md).
  await safe(() => context.storageState({ path: '/home/sprite/pw/storageState.json' }));
  console.log('STORAGE_SAVED');

  console.log('BODY_LEN:', bodyText.length);
  console.log('BODY_TEXT_START');
  console.log(bodyText.slice(0, 15000));
  console.log('BODY_TEXT_END');

  await safe(() => page.screenshot({ path: '/home/sprite/pw/page.png', fullPage: true }));
  console.log('SCREENSHOT_SAVED');

  // --- Add further scraping/automation HERE, inside this same process,  ---
  // --- rather than in a script you launch later. Keep wrapping in safe(). ---

  console.log('KEEP_ALIVE');
  await new Promise(() => {}); // never resolves: keeps Chrome + the login session open
})().catch((e) => {
  // Deliberately NOT process.exit(1) here — an exit triggers Sprites'
  // auto-restart, which is exactly what we're trying to avoid.
  console.error('FATAL_ERROR:', e.message);
});
