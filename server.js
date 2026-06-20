require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || null;
const CS_EMAIL = process.env.CS_EMAIL;
const CS_PASSWORD = process.env.CS_PASSWORD;
const LEAGUE_URL = 'https://cod-stats.com/amateur-leagues/average-joes-cod-league';
const LEADERBOARD_TTL_MS = 5 * 60 * 1000;
const SEASONS = ['Season 9 Academy', 'Season 9 Premier'];
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const MAX_REQUESTS_BEFORE_RECYCLE = 25;

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

let browserPromise = null;
let loggedInPage = null;
let leaderboardCache = { byGamertag: new Map(), fetchedAt: 0 };
let requestsSinceLaunch = 0;

// Single-flight queue: only one puppeteer operation runs at a time. The
// free-tier instance OOMs and silently dies under concurrent page load, and
// once the underlying Chrome process is gone every later request just hits
// a dead browser handle forever (no auto-recovery) unless we detect it here.
let queueTail = Promise.resolve();
function runQueued(fn) {
  const result = queueTail.then(fn, fn);
  queueTail = result.catch(() => {});
  return result;
}

async function resetBrowser() {
  requestsSinceLaunch = 0;
  loggedInPage = null;
  const old = browserPromise;
  browserPromise = null;
  if (old) {
    try {
      const browser = await old;
      await browser.close();
    } catch (e) {}
  }
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const browser = await browserPromise;
    browser.on('disconnected', () => {
      browserPromise = null;
      loggedInPage = null;
    });
  }
  return browserPromise;
}

async function login(page) {
  await page.goto('https://cod-stats.com/auth', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('#login-identifier', { timeout: 10000 });
  await page.type('#login-identifier', CS_EMAIL);
  await page.type('#login-password', CS_PASSWORD);
  const buttons = await page.$$('button');
  for (const b of buttons) {
    const txt = await b.evaluate(el => el.textContent.trim());
    if (txt === 'Sign In') { await b.click(); break; }
  }
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
}

async function getLoggedInPage() {
  if (loggedInPage) return loggedInPage;
  const browser = await getBrowser();
  const page = await browser.newPage();
  if (CS_EMAIL && CS_PASSWORD) {
    await login(page);
  }
  loggedInPage = page;
  return page;
}

// Polls for a button with matching text instead of a single check, since the
// SPA can take a beat to render after a tab switch — a fixed sleep before a
// one-shot search is what caused intermittent "button not found" failures.
async function clickButtonWithText(page, text, exact = false, retries = 8, delayMs = 400) {
  for (let i = 0; i < retries; i++) {
    const buttons = await page.$$('button');
    for (const b of buttons) {
      const txt = await b.evaluate(el => el.textContent.trim());
      if (exact ? txt === text : txt.includes(text)) {
        await b.click();
        return true;
      }
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

async function scrapeSeasonPlayers(page, seasonLabel) {
  await page.goto(LEAGUE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1200));
  await clickButtonWithText(page, seasonLabel);
  await new Promise(r => setTimeout(r, 1500));
  await clickButtonWithText(page, 'Players', true);
  await new Promise(r => setTimeout(r, 2000));

  const rows = await page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll('tbody tr'));
    return trs.map(tr => {
      const link = tr.querySelector('a[href*="/player/"]');
      if (!link) return null;
      const href = link.getAttribute('href');
      const gamertag = decodeURIComponent(href.split('/player/')[1] || '');
      const cells = Array.from(tr.querySelectorAll('td'));
      const ratingText = cells[3]?.querySelector('span.font-bold')?.textContent.trim();
      const kills = cells[5]?.textContent.trim();
      const deaths = cells[6]?.textContent.trim();
      const avgDmg = cells[7]?.textContent.trim();
      const wins = cells[9]?.textContent.trim();
      const losses = cells[10]?.textContent.trim();
      const community = cells[12]?.textContent.trim();
      return { gamertag, rating: ratingText, kills, deaths, avgDmg, wins, losses, community };
    }).filter(Boolean);
  });

  await page.goto('about:blank').catch(() => {});
  return rows.map(r => ({ ...r, season: seasonLabel }));
}

async function refreshLeaderboard() {
  const page = await getLoggedInPage();
  const byGamertag = new Map();

  for (const season of SEASONS) {
    const rows = await scrapeSeasonPlayers(page, season);
    for (const row of rows) {
      byGamertag.set(row.gamertag.toLowerCase(), row);
    }
  }

  leaderboardCache = { byGamertag, fetchedAt: Date.now() };
  return leaderboardCache;
}

async function getLeaderboard() {
  if (Date.now() - leaderboardCache.fetchedAt > LEADERBOARD_TTL_MS) {
    await refreshLeaderboard();
  }
  return leaderboardCache;
}

async function scrapePublicProfile(gamertag) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const url = `${LEAGUE_URL}/player/${encodeURIComponent(gamertag)}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));

    return await page.evaluate(() => {
      const notFound = document.body.innerText.includes('404') || document.body.innerText.includes("doesn't exist");
      if (notFound) return { found: false };

      const name = document.querySelector('h1')?.textContent.trim() || null;
      const teamName = (() => {
        const h1 = document.querySelector('h1');
        const teamP = h1?.parentElement?.parentElement?.querySelector('p');
        return teamP?.textContent.trim() || null;
      })();

      const statBlocks = Array.from(document.querySelectorAll('p.uppercase.tracking-wide'));
      const stats = {};
      for (const label of statBlocks) {
        const key = label.textContent.trim();
        const value = label.nextElementSibling?.textContent.trim();
        if (key && value) stats[key] = value;
      }

      if (!name && Object.keys(stats).length === 0) return { found: false };
      return { found: true, name, teamName, stats };
    });
  } finally {
    await page.close();
  }
}

async function lookupPlayerInner(gamertag) {
  const profile = await scrapePublicProfile(gamertag);
  if (!profile.found) return { found: false };

  let overall = null;
  if (CS_EMAIL && CS_PASSWORD) {
    try {
      const { byGamertag } = await getLeaderboard();
      overall = byGamertag.get(gamertag.toLowerCase()) || null;
    } catch (e) {
      overall = null;
    }
  }

  return {
    found: true,
    name: profile.name,
    teamName: profile.teamName,
    stats: profile.stats,
    overall: overall ? {
      season: overall.season,
      rating: overall.rating,
      kills: overall.kills,
      deaths: overall.deaths,
      avgDmg: overall.avgDmg,
      wins: overall.wins,
      losses: overall.losses,
      community: overall.community
    } : null
  };
}

async function downloadPlayerCardInner(gamertag) {
  const { byGamertag } = await getLeaderboard();
  const entry = byGamertag.get(gamertag.toLowerCase());
  if (!entry) return null;

  // Ensures this browser instance has an authenticated session. Cheap no-op
  // if already logged in; necessary right after a recycle, since a fresh
  // browser has no cookies even while the leaderboard cache is still warm.
  await getLoggedInPage();

  const browser = await getBrowser();
  const page = await browser.newPage();
  const client = await page.createCDPSession();
  const downloadPath = path.join(DOWNLOAD_DIR, `${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(downloadPath, { recursive: true });
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath });

  try {
    await page.goto(LEAGUE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1200));
    const seasonClicked = await clickButtonWithText(page, entry.season);
    if (!seasonClicked) return null;
    await new Promise(r => setTimeout(r, 1500));
    const playersClicked = await clickButtonWithText(page, 'Players', true);
    if (!playersClicked) return null;
    await new Promise(r => setTimeout(r, 2000));

    let clicked = false;
    for (let i = 0; i < 6 && !clicked; i++) {
      clicked = await page.evaluate((targetTag) => {
        const all = Array.from(document.querySelectorAll('a[href*="/player/"]'));
        const link = all.find(a => decodeURIComponent(a.getAttribute('href').split('/player/')[1] || '').toLowerCase() === targetTag.toLowerCase());
        if (!link) return false;
        let row = link;
        while (row && row.tagName !== 'TR') row = row.parentElement;
        if (!row) return false;
        const imgIcon = row.querySelector('svg.lucide-image');
        if (!imgIcon) return false;
        imgIcon.closest('button').click();
        return true;
      }, gamertag);
      if (!clicked) await new Promise(r => setTimeout(r, 400));
    }
    if (!clicked) return null;
    await new Promise(r => setTimeout(r, 1500));

    let downloadClicked = false;
    for (let i = 0; i < 6 && !downloadClicked; i++) {
      downloadClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const dl = buttons.find(b => b.textContent.includes('Download PNG'));
        if (!dl) return false;
        dl.click();
        return true;
      });
      if (!downloadClicked) await new Promise(r => setTimeout(r, 400));
    }
    if (!downloadClicked) return null;

    let attempts = 0;
    let files = [];
    while (attempts < 20) {
      await new Promise(r => setTimeout(r, 500));
      files = fs.readdirSync(downloadPath).filter(f => !f.endsWith('.crdownload'));
      if (files.length > 0) break;
      attempts++;
    }
    if (files.length === 0) return null;

    const buffer = fs.readFileSync(path.join(downloadPath, files[0]));
    return buffer;
  } finally {
    await page.close();
    fs.rmSync(downloadPath, { recursive: true, force: true });
  }
}

// Wraps a puppeteer-dependent operation: serializes it behind the queue,
// recycles the browser periodically to bound memory growth, and retries
// once after a hard reset if the browser/page turns out to be dead.
async function withBrowserOp(fn) {
  return runQueued(async () => {
    requestsSinceLaunch++;
    if (requestsSinceLaunch > MAX_REQUESTS_BEFORE_RECYCLE) {
      await resetBrowser();
    }
    try {
      return await fn();
    } catch (e) {
      const msg = (e && e.message) || '';
      const looksDead = /disconnected|detached|Target closed|Protocol error|Session closed/i.test(msg);
      if (looksDead) {
        await resetBrowser();
        return await fn();
      }
      throw e;
    }
  });
}

function checkAuth(req) {
  if (!AUTH_TOKEN) return true;
  const provided = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  return provided === AUTH_TOKEN;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const cardMatch = url.pathname.match(/^\/player\/([^/]+)\/card$/);
  if (cardMatch) {
    if (!checkAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const gamertag = decodeURIComponent(cardMatch[1]);
    try {
      const buffer = await withBrowserOp(() => downloadPlayerCardInner(gamertag));
      if (!buffer) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'card not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(buffer);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  const match = url.pathname.match(/^\/player\/([^/]+)$/);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  if (!checkAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const gamertag = decodeURIComponent(match[1]);

  try {
    const result = await withBrowserOp(() => lookupPlayerInner(gamertag));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`codstats-scraper-service listening on port ${PORT}`);
});
