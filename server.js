require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const puppeteer = require('puppeteer');

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || null;
const CS_EMAIL = process.env.CS_EMAIL;
const CS_PASSWORD = process.env.CS_PASSWORD;
const LEAGUE_URL = 'https://cod-stats.com/amateur-leagues/average-joes-cod-league';
const LEADERBOARD_TTL_MS = 5 * 60 * 1000;

let browserPromise = null;
let loggedInPage = null;
let leaderboardCache = { byGamertag: new Map(), fetchedAt: 0 };

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
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

async function refreshLeaderboard() {
  const page = await getLoggedInPage();
  await page.goto(LEAGUE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1200));

  const buttons = await page.$$('button');
  for (const b of buttons) {
    const txt = await b.evaluate(el => el.textContent.trim());
    if (txt === 'Overall') { await b.click(); break; }
  }
  await new Promise(r => setTimeout(r, 2000));

  const rows = await page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll('tbody tr'));
    return trs.map(tr => {
      const link = tr.querySelector('a[href*="/player/"]');
      if (!link) return null;
      const href = link.getAttribute('href');
      const gamertag = decodeURIComponent(href.split('/player/')[1] || '');
      const cells = Array.from(tr.querySelectorAll('td'));
      const ratingText = cells[2]?.querySelector('span.font-bold')?.textContent.trim();
      const kills = cells[4]?.textContent.trim();
      const deaths = cells[5]?.textContent.trim();
      const avgDmg = cells[6]?.textContent.trim();
      const wins = cells[8]?.textContent.trim();
      const losses = cells[9]?.textContent.trim();
      const community = cells[11]?.textContent.trim();
      return { gamertag, rating: ratingText, kills, deaths, avgDmg, wins, losses, community };
    }).filter(Boolean);
  });

  await page.goto('about:blank').catch(() => {});

  const byGamertag = new Map();
  for (const row of rows) {
    byGamertag.set(row.gamertag.toLowerCase(), row);
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

async function lookupPlayer(gamertag) {
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const match = url.pathname.match(/^\/player\/([^/]+)$/);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  if (AUTH_TOKEN) {
    const provided = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (provided !== AUTH_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
  }

  const gamertag = decodeURIComponent(match[1]);

  try {
    const result = await lookupPlayer(gamertag);
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
