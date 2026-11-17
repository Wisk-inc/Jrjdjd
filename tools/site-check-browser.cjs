// Opens the live pages in a real browser and reports what a visitor gets:
//
//   NODE_PATH=<dir with playwright-core> node tools/site-check-browser.cjs https://www.corx-labs.com
//
// Run by .github/workflows/site-check.yml after tools/site-check.py. For each page: errors in the
// console (a Content-Security-Policy refusal shows up here), failed requests and error answers. On
// Scam Radar it also reads how old the data on screen is, whether fresh data came from the
// scam-radar-data branch, the numbers drawn, the Jamaica watch, what the link checker's deep dive says
// about a made-up link and what the contact checker says about a made-up number.
// It changes nothing. It exits with 0 even when it finds problems; the log says what they are.
const { chromium } = require('playwright-core');

const site = (process.argv[2] || 'https://www.corx-labs.com').replace(/\/$/, '');
const problems = [];

const launch = async () => {
  try {
    return await chromium.launch({ channel: 'chrome' });
  } catch (error) {
    console.log(`Chrome not found (${error.message.split('\n')[0]}); trying Chromium`);
    return chromium.launch();
  }
};

const visit = async (browser, path, width, inspect) => {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const raw = [];
  let noApi = false;
  // The pages ask /api/scam-finder?ping=1 whether this host runs the scan API. A 404 there means it
  // does not, which is a fact to report, not a fault.
  const isPing = (url) => /\/api\/scam-finder\?ping=1/.test(url || '');
  page.on('console', (m) => {
    if (m.type() === 'error' && !isPing(m.location()?.url)) errors.push(`console: ${m.text().slice(0, 240)}`);
  });
  page.on('pageerror', (e) => errors.push(`script error: ${e.message.slice(0, 240)}`));
  page.on('requestfailed', (r) => errors.push(`failed: ${r.url().slice(0, 160)} (${r.failure()?.errorText})`));
  page.on('response', (r) => {
    if (r.url().includes('raw.githubusercontent.com')) raw.push(`${r.status()} ${r.url().split('?')[0].split('/').slice(-1)[0]}`);
    else if (isPing(r.url()) && r.status() === 404) noApi = true;
    else if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url().slice(0, 160)}`);
  });
  const started = Date.now();
  let status = null;
  try {
    const answer = await page.goto(site + path, { waitUntil: 'networkidle', timeout: 60000 });
    status = answer?.status();
  } catch (error) {
    errors.push(`did not load: ${error.message.split('\n')[0]}`);
  }
  await page.waitForTimeout(3000);
  console.log(`\n${path} at ${width}px: HTTP ${status}, loaded in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (inspect) {
    try {
      await inspect(page, raw);
    } catch (error) {
      console.log(`  could not inspect the page: ${error.message.split('\n')[0]}`);
      problems.push(`${path}: could not inspect (${error.message.split('\n')[0]})`);
    }
  }
  if (noApi) console.log('  the scan API is not on this host (its ping answered 404), so link checks do not visit pages');
  if (errors.length) {
    console.log(`  ${errors.length} error(s):`);
    for (const e of errors.slice(0, 15)) console.log(`   - ${e}`);
    problems.push(`${path}: ${errors.length} error(s) in the browser`);
  } else {
    console.log('  no errors in the console, no failed requests');
  }
  await context.close();
};

const text = (page, selector) => page.locator(selector).first().textContent({ timeout: 5000 })
  .then((t) => (t || '').replace(/\s+/g, ' ').trim()).catch(() => '(not found)');

(async () => {
  const browser = await launch();
  console.log(`Browser: ${browser.version()}`);

  await visit(browser, '/scam-radar/', 390, async (page, raw) => {
    console.log(`  data age on screen: ${await text(page, '#sr-age')}`);
    console.log(`  console: ${await text(page, '#sr-live-state')}: ${await text(page, '#sr-live-detail')}`);
    console.log(`  chart: ${await page.locator('#sr-cycles-chart .sr-col:not(.is-empty)').count()} cycles in the last hour; ${await text(page, '#sr-cycle-now')}`);
    console.log(`  fetched from the scam-radar-data branch: ${raw.length ? raw.join(', ') : 'NOTHING'}`);
    if (!raw.some((r) => r.startsWith('200'))) problems.push('/scam-radar/ did not load fresh data from the scam-radar-data branch');
    const tiles = await page.$$eval('dd[data-k]', (els) => els.map((el) => `${el.dataset.k}=${el.textContent.trim()}`));
    console.log(`  numbers: ${tiles.join(', ') || '(none)'}`);
    const feed = await page.locator('#sr-feed li').count().catch(() => 0);
    const named = await page.locator('#named li, #named tr').count().catch(() => 0);
    console.log(`  feed items: ${feed}, named rows: ${named}`);
    console.log(`  Jamaica watch: ${await text(page, '#sr-jm-stats')} | ${await text(page, '#sr-jm-hunt')}`);
    // A made-up look-alike: the deep dive takes up to 40 seconds, so wait for its result
    await page.fill('#sr-check-input', 'paypal-account-verify-login.top');
    await page.locator('#sr-check button[type="submit"], #sr-check button').first().click();
    const began = Date.now();
    while (Date.now() - began < 60000 && await page.locator('.sr-deep-clock').count()) await page.waitForTimeout(1000);
    console.log(`  link checker on a made-up look-alike, after ${Math.round((Date.now() - began) / 1000)} s: ${(await text(page, '#sr-check-result')).slice(0, 500)}`);
    // A made-up Jamaican number (555-01xx numbers are reserved for fiction)
    await page.fill('#sr-check-input', '+1 876 555 0100');
    await page.locator('#sr-check button[type="submit"], #sr-check button').first().click();
    await page.waitForTimeout(5000);
    console.log(`  contact checker on a made-up number: ${(await text(page, '#sr-check-result')).slice(0, 400)}`);
  });

  await visit(browser, '/scam-radar/map/', 1440, async (page) => {
    const main = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 300));
    console.log(`  page text: ${main}`);
  });
  // A crafted link must not point the map at another server
  await visit(browser, '/scam-radar/map/?api=https://example.trycloudflare.com/x&radar-api=https://example.trycloudflare.com/y', 1440, async (page) => {
    const left = new URL(page.url()).search;
    console.log(`  address after the page loaded: ${left || '(no parameters)'}`);
    if (/api=/.test(left)) problems.push('/scam-radar/map/ kept ?api= or ?radar-api= in its address');
  });

  await visit(browser, '/models/pluvium/', 390, async (page) => {
    const links = await page.locator('a[href*="huggingface.co/CorxLabs/Pluvium-500"]').count();
    console.log(`  links to the Pluvium-500 checkpoint: ${links}`);
    if (!links) problems.push('/models/pluvium/ has no link to the Pluvium-500 checkpoint');
  });

  await visit(browser, '/', 1440, null);
  await visit(browser, '/automa/', 390, null);

  await browser.close();
  console.log(problems.length ? `\nProblems:\n${problems.map((p) => `- ${p}`).join('\n')}` : '\nNo problems found in the browser.');
})().catch((error) => {
  console.log(`The browser check stopped: ${error.stack || error}`);
});
