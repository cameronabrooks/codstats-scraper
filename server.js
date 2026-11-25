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
const BRACKET_DIVISIONS = ['Academy Mini SZN', 'Premier Mini SZN'];
const ROUND_HEADER_RE = /^(WINNERS|LOSERS)\s+(BRACKET|R\d+|SEMIS|FINALS)$|^GRAND FINALS$|^IF NECESSARY$/;
const LEADERBOARD_TTL_MS = 5 * 60 * 1000;
const SEASONS = ['Academy Mini SZN', 'Premier Mini SZN'];
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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
      ]
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

// Reads a season's public cod-stats player-stats embed (no login needed):
// https://cod-stats.com/embed/average-joes-cod-league/players?season=<id>
// Returns { season, headers, rows: [{ player, team, stats: { "K/D": "1.62", ... } }] }.
const EMBED_PLAYERS_URL = 'https://cod-stats.com/embed/average-joes-cod-league/players';
async function scrapeEmbedPlayersInner(seasonId) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(`${EMBED_PLAYERS_URL}?season=${encodeURIComponent(seasonId)}`, { waitUntil: 'networkidle2', timeout: 60000 });
    // Either the table renders or the "no stats yet" message does.
    await page.waitForFunction(
      () => document.querySelector('table tbody tr') || /No player statistics/i.test(document.body.innerText),
      { timeout: 20000 }
    ).catch(() => {});
    return await page.evaluate(() => {
      const t = document.querySelector('table');
      if (!t) return { headers: [], rows: [], empty: /No player statistics/i.test(document.body.innerText) };
      const headers = [...t.querySelectorAll('thead th')].map(th => th.innerText.trim());
      const rows = [...t.querySelectorAll('tbody tr')].map(tr => {
        const cells = [...tr.querySelectorAll('td')].map(td => td.innerText.trim().replace(/\s+/g, ' '));
        const row = {};
        headers.forEach((h, i) => { if (h) row[h] = cells[i]; });
        return { player: row.PLAYER || '', team: row.TEAM || '', stats: row };
      }).filter(r => r.player);
      return { headers, rows, empty: rows.length === 0 };
    });
  } finally {
    await page.close();
  }
}

async function scrapeBracketInner(page, division) {
  await page.goto(LEAGUE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  // Click the division tab
  await page.waitForFunction(
    (text) => Array.from(document.querySelectorAll('[role="tab"], button')).some(el => el.textContent.trim().startsWith(text)),
    { timeout: 15000 },
    division
  );
  const divHandle = await page.evaluateHandle((text) => {
    return Array.from(document.querySelectorAll('[role="tab"], button')).find(el => el.textContent.trim().startsWith(text)) || null;
  }, division);
  const divEl = divHandle.asElement();
  if (!divEl) { await divHandle.dispose(); throw new Error(`Tab not found: ${division}`); }
  await divEl.click();
  await divHandle.dispose();

  // Click Playoffs tab
  await page.waitForFunction(
    (text) => Array.from(document.querySelectorAll('[role="tab"], button')).some(el => el.textContent.trim().startsWith(text)),
    { timeout: 15000 },
    'Playoffs'
  );
  const playoffsHandle = await page.evaluateHandle(() => {
    return Array.from(document.querySelectorAll('[role="tab"], button')).find(el => el.textContent.trim().startsWith('Playoffs')) || null;
  });
  const playoffsEl = playoffsHandle.asElement();
  if (!playoffsEl) { await playoffsHandle.dispose(); throw new Error('Playoffs tab not found'); }
  await playoffsEl.click();
  await playoffsHandle.dispose();

  await page.waitForFunction(
    () => document.body.innerText.includes('WINNERS BRACKET'),
    { timeout: 20000 }
  );
  return await page.evaluate(() => document.body.innerText);
}

function parseBracketText(text, divisionLabel) {
  const tokens = text.split('\n').map(l => l.trim()).filter(Boolean);
  const matches = [];
  let side = null;
  let roundLabel = null;
  let i = 0;

  function readTeam() {
    if (tokens[i] === 'TBD') { const score = Number(tokens[i + 1]); i += 2; return { name: 'TBD', tag: null, seed: null, score }; }
    if (/^#\d+$/.test(tokens[i])) {
      const seed = tokens[i]; const name = tokens[i + 1]; const tag = tokens[i + 2]; const score = Number(tokens[i + 3]);
      i += 4;
      return { name, tag, seed, score };
    }
    return null;
  }

  while (i < tokens.length) {
    const token = tokens[i];
    if (token === 'WINNERS BRACKET') { side = 'Winners'; i++; continue; }
    if (token === 'LOSERS BRACKET') { side = 'Losers'; i++; continue; }
    if (token === 'GRAND FINALS') { side = 'Grand Finals'; roundLabel = null; i++; continue; }
    if (token === 'IF NECESSARY') { roundLabel = 'If Necessary'; i++; continue; }
    if (ROUND_HEADER_RE.test(token)) { roundLabel = token; i++; continue; }
    const startIdx = i;
    const teamA = readTeam();
    if (!teamA) { i++; continue; }
    if (tokens[i] !== 'VS') { i = startIdx + 1; continue; }
    i++;
    const teamB = readTeam();
    if (!teamB) { i = startIdx + 1; continue; }
    const letter = tokens[i]; i++;
    const boLine = tokens[i] || ''; i++;
    const boMatch = boLine.match(/^BO(\d+)\s*[•·]\s*(.+)$/i);
    const bestOf = boMatch ? Number(boMatch[1]) : null;
    const dateText = boMatch ? boMatch[2].trim() : boLine;
    matches.push({
      division: divisionLabel,
      side: side || (roundLabel === 'GRAND FINALS' ? 'Grand Finals' : null),
      round: roundLabel || (side === 'Grand Finals' ? 'Grand Finals' : null),
      letter, teamA, teamB, bestOf, dateText
    });
  }
  return matches;
}

async function scrapeAllBracketsInner() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  const results = {};
  try {
    for (const division of BRACKET_DIVISIONS) {
      try {
        const text = await scrapeBracketInner(page, division);
        results[division] = parseBracketText(text, division);
      } catch (e) {
        console.error(`bracketScrape: failed for ${division}: ${e.message}`);
        results[division] = [];
      }
    }
  } finally {
    await page.close();
  }
  return results;
}

const REGULAR_SEASON_DIVISIONS = ['Academy Mini SZN', 'Premier Mini SZN'];

async function scrapeRegularSeasonInner(page, division) {
  // Navigate directly to the schedule tab
  await page.goto(`${LEAGUE_URL}?tab=schedule`, { waitUntil: 'domcontentloaded', timeout: 120000 });

  // Click the division tab (Academy Mini SZN / Premier Mini SZN)
  await page.waitForFunction(
    (text) => Array.from(document.querySelectorAll('[role="tab"], button')).some(el => el.textContent.trim().startsWith(text)),
    { timeout: 15000 },
    division
  );
  const divHandle = await page.evaluateHandle((text) => {
    return Array.from(document.querySelectorAll('[role="tab"], button')).find(el => el.textContent.trim().startsWith(text)) || null;
  }, division);
  const divEl = divHandle.asElement();
  if (!divEl) { await divHandle.dispose(); throw new Error(`Tab not found: ${division}`); }
  await divEl.click();
  await divHandle.dispose();

  await page.waitForFunction(
    () => document.body.innerText.includes('WEEK') || document.body.innerText.includes('Week'),
    { timeout: 20000 }
  );
  return await page.evaluate(() => document.body.innerText);
}

// Actual page text format per match:
//   WEEK 1
//   TBD
//   Regular
//   Lexington Majestic
//   LEX          ← 2-4 char abbreviation
//   VS
//   Montreal Red Dragons
//   MRD          ← 2-4 char abbreviation
//   GStake
//   Preview
function parseRegularSeasonText(text, divisionLabel) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const weeks = {};
  let currentWeek = null;
  let i = 0;

  const isAbbrev = s => /^[A-Z]{2,5}$/.test(s);
  const isRecord = s => /^\(\d+-\d+\)$/.test(s);
  const isOdds = s => /^\d+\.\d+$/.test(s);
  const isSkip = s => ['GStake', 'Preview', 'TBD', 'Regular', 'Confirmed'].includes(s) || /^\d{1,2}\/\d{1,2}/.test(s) || isRecord(s) || isOdds(s);

  while (i < lines.length) {
    const line = lines[i];

    const weekMatch = line.match(/^WEEK\s+(\d+)$/i);
    if (weekMatch) {
      currentWeek = parseInt(weekMatch[1], 10);
      if (!weeks[currentWeek]) weeks[currentWeek] = [];
      i++;
      continue;
    }

    if (!currentWeek || isSkip(line) || isAbbrev(line)) { i++; continue; }

    // Expect: TeamA name, TeamA abbrev, VS, TeamB name, TeamB abbrev
    const teamAName = line;
    const afterAName = i + 1;
    if (!isAbbrev(lines[afterAName])) { i++; continue; }
    // skip optional record like (0-0) and optional GStake odds like 1.25
    let vsIdx = afterAName + 1;
    while (vsIdx < lines.length && (isRecord(lines[vsIdx]) || isOdds(lines[vsIdx]))) vsIdx++;
    if (lines[vsIdx] !== 'VS') { i++; continue; }
    const teamBName = lines[vsIdx + 1];
    if (!teamBName || isSkip(teamBName) || teamBName === 'VS') { i++; continue; }
    const afterBName = vsIdx + 2;
    if (!isAbbrev(lines[afterBName])) { i++; continue; }

    const abbrevA = lines[afterAName];
    const abbrevB = lines[afterBName];
    const letter = `${abbrevA}v${abbrevB}-W${currentWeek}`;

    weeks[currentWeek].push({
      division: divisionLabel,
      week: currentWeek,
      teamAName,
      teamBName,
      letter,
    });

    // skip past team B's abbrev, record, and odds
    let nextIdx = afterBName + 1;
    while (nextIdx < lines.length && (isRecord(lines[nextIdx]) || isOdds(lines[nextIdx]))) nextIdx++;
    i = nextIdx;
  }

  return weeks;
}

async function scrapeAllRegularSeasonInner() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  const results = {};
  try {
    for (const division of REGULAR_SEASON_DIVISIONS) {
      try {
        const text = await scrapeRegularSeasonInner(page, division);
        results[division] = parseRegularSeasonText(text, division);
      } catch (e) {
        console.error(`regularSeasonScrape: failed for ${division}: ${e.message}`);
        results[division] = {};
      }
    }
  } finally {
    await page.close();
  }
  return results;
}

// ── Match scorecards (signed in) ──────────────────────────────────────────────
// cod-stats only shows a match's detailed stats (scorecards, per-player numbers)
// to signed-in users. This reads them the way a person would: open the league's
// Results tab for one season, click each match's "Stats" button, and copy every
// table in the pop-up (once per map/tab inside it). Matches with no detailed
// stats ("No detailed stats tracked") come back with just the score.
// GET /match-stats?game=MW4&season=SZN%20X%20Premier[&skip=<id>,<id>][&debug=1]
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function clickByText(page, text, { exact = false, within = null } = {}) {
  return page.evaluate((text, exact, within) => {
    const root = within ? document.querySelector(within) : document;
    if (!root) return false;
    const els = Array.from(root.querySelectorAll('button, [role="tab"], a'));
    const el = els.find(e => { const t = e.textContent.trim(); return exact ? t === text : t.startsWith(text); });
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }, text, exact, within);
}

async function waitForText(page, text, timeout = 15000) {
  await page.waitForFunction(t => Array.from(document.querySelectorAll('button, [role="tab"], a')).some(e => e.textContent.trim().startsWith(t)), { timeout }, text);
}

// Result cards on the current Results page: one per match.
async function readResultCards(page) {
  return page.evaluate(() => {
    const statsButtons = Array.from(document.querySelectorAll('main button')).filter(b => b.textContent.trim() === 'Stats');
    return statsButtons.map((btn, index) => {
      // The card is the biggest ancestor that holds only this one Stats button.
      let card = btn;
      while (card.parentElement && card.parentElement.tagName !== 'MAIN' &&
        Array.from(card.parentElement.querySelectorAll('button')).filter(b => b.textContent.trim() === 'Stats').length === 1) card = card.parentElement;
      const lines = card.innerText.split('\n').map(s => s.trim()).filter(Boolean);
      return { index, lines, noStats: /No detailed stats tracked/i.test(card.innerText) };
    });
  });
}

// "Aug 16 | 10:00 PM | Regular | BO5 | Online | Kansas City Kings | KCK | 1 | - | 3 | Dominant | Manhattan Mafia | MAN | Stats ..."
function parseCard(lines) {
  const dash = lines.indexOf('-');
  if (dash < 3) return null;
  const scoreA = Number(lines[dash - 1]), scoreB = Number(lines[dash + 1]);
  const abbrA = lines[dash - 2], nameA = lines[dash - 3];
  let j = dash + 2;
  if (!/^[A-Z0-9]{2,5}$/.test(lines[j + 1] || '')) j++; // skip "Sweep" / "Close" / "Dominant"
  const nameB = lines[j], abbrB = lines[j + 1];
  const head = lines.slice(0, Math.max(0, dash - 3));
  const date = head[0] && !/^Date N\/A$/i.test(head[0]) ? head.slice(0, 2).join(' ').replace(/•/g, ' ').trim() : null;
  const stage = head.find(s => /^(Regular|Playoff)$/i.test(s)) || null;
  const format = head.find(s => /^BO\d$/i.test(s)) || null;
  return { date, stage, format, teamA: { name: nameA, abbr: abbrA, score: scoreA }, teamB: { name: nameB, abbr: abbrB, score: scoreB } };
}

// Every table (and its nearest heading) inside the open match pop-up.
async function readDialogTables(page) {
  return page.evaluate(() => {
    const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).find(d => !/Opt out of the sale/i.test(d.innerText));
    if (!dlg) return null;
    const headingFor = el => {
      let n = el;
      for (let k = 0; k < 6 && n; k++) {
        let p = n.previousElementSibling;
        while (p) {
          const h = p.matches('h1,h2,h3,h4,h5,h6,[class*="title"],[class*="header"]') ? p : p.querySelector && p.querySelector('h1,h2,h3,h4,h5,h6');
          if (h && h.innerText.trim()) return h.innerText.trim().split('\n')[0].slice(0, 80);
          p = p.previousElementSibling;
        }
        n = n.parentElement;
      }
      return '';
    };
    const tables = Array.from(dlg.querySelectorAll('table')).map(t => {
      const headers = Array.from(t.querySelectorAll('thead th')).map(th => th.innerText.trim().replace(/\s+/g, ' '));
      const rows = Array.from(t.querySelectorAll('tbody tr')).map(tr => Array.from(tr.querySelectorAll('td,th')).map(td => td.innerText.trim().replace(/\s+/g, ' '))).filter(r => r.some(Boolean));
      return { title: headingFor(t), headers, rows };
    }).filter(t => t.rows.length);
    return { title: (dlg.querySelector('h1,h2,h3') || {}).innerText || '', tables, text: dlg.innerText.slice(0, 4000) };
  });
}

async function scrapeMatchStatsInner({ game, season, skip, debug }) {
  const page = await getLoggedInPage();
  await page.setViewport({ width: 1400, height: 1000 });
  await page.goto(`${LEAGUE_URL}?tab=results`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);
  await clickByText(page, 'Reject non-essential').catch(() => {});
  const signedIn = await page.evaluate(() => !Array.from(document.querySelectorAll('a, button')).some(e => /^(Login|Sign In)$/i.test(e.textContent.trim())));
  if (game) { await waitForText(page, game); await clickByText(page, game, { exact: true }); await sleep(2500); }
  await waitForText(page, season);
  if (!await clickByText(page, season)) throw new Error(`Season tab not found: ${season}`);
  await sleep(2500);
  await clickByText(page, 'Results', { exact: true });
  await sleep(3000);

  const out = [];
  const seen = new Set();
  let debugDialog = null;
  for (let pageNo = 0; pageNo < 20; pageNo++) {
    const cards = await readResultCards(page);
    for (const card of cards) {
      const info = parseCard(card.lines);
      if (!info) continue;
      const entry = { ...info, matchId: null, hasStats: !card.noStats, views: [] };
      if (card.noStats) { out.push(entry); continue; }
      // Open the pop-up: the URL gets ?match=<id>.
      await page.evaluate(i => {
        const b = Array.from(document.querySelectorAll('main button')).filter(x => x.textContent.trim() === 'Stats')[i];
        if (b) { b.scrollIntoView({ block: 'center' }); b.click(); }
      }, card.index);
      await page.waitForFunction(() => /[?&]match=/.test(location.search), { timeout: 10000 }).catch(() => {});
      entry.matchId = new URL(page.url()).searchParams.get('match');
      if (entry.matchId && (seen.has(entry.matchId) || skip.has(entry.matchId))) {
        entry.skipped = true; out.push(entry);
        await page.keyboard.press('Escape'); await sleep(600);
        continue;
      }
      await page.waitForFunction(() => {
        const d = Array.from(document.querySelectorAll('[role="dialog"]')).find(x => !/Opt out of the sale/i.test(x.innerText));
        return d && (d.querySelector('table') || /Require Login/i.test(d.innerText));
      }, { timeout: 15000 }).catch(() => {});
      const first = await readDialogTables(page);
      if (first && /Require Login/i.test(first.text)) {
        await page.keyboard.press('Escape');
        throw new Error('cod-stats asked to sign in for match stats (login not working)');
      }
      if (debug && !debugDialog && first) debugDialog = first.text;
      // Tabs inside the pop-up (overall / each map): read the tables under each.
      const tabs = await page.evaluate(() => {
        const d = Array.from(document.querySelectorAll('[role="dialog"]')).find(x => !/Opt out of the sale/i.test(x.innerText));
        return d ? Array.from(d.querySelectorAll('[role="tab"]')).map(t => t.textContent.trim()).filter(Boolean) : [];
      });
      if (tabs.length > 1) {
        for (let t = 0; t < tabs.length; t++) {
          await page.evaluate(t => {
            const d = Array.from(document.querySelectorAll('[role="dialog"]')).find(x => !/Opt out of the sale/i.test(x.innerText));
            const el = d && d.querySelectorAll('[role="tab"]')[t];
            if (el) el.click();
          }, t);
          await sleep(1200);
          const v = await readDialogTables(page);
          if (v && v.tables.length) entry.views.push({ label: tabs[t], tables: v.tables });
        }
      } else if (first) {
        entry.views.push({ label: 'Match', tables: first.tables });
      }
      if (entry.matchId) seen.add(entry.matchId);
      out.push(entry);
      await page.keyboard.press('Escape');
      await sleep(800);
      // Some pop-ups ignore Escape: drop the ?match= by going back.
      if (/[?&]match=/.test(new URL(page.url()).search)) {
        await clickByText(page, 'Close', { exact: true, within: '[role="dialog"]' }).catch(() => {});
        await sleep(600);
      }
    }
    const moved = await page.evaluate(() => {
      const next = Array.from(document.querySelectorAll('main button')).find(b => b.textContent.trim() === 'Next');
      if (!next || next.disabled) return false;
      next.click(); return true;
    });
    if (!moved) break;
    await sleep(2200);
  }
  await page.goto('about:blank').catch(() => {});
  return { game, season, signedIn, matches: out, ...(debug ? { debugDialog } : {}) };
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

  if (url.pathname === '/regular-season') {
    try {
      const data = await withBrowserOp(() => scrapeAllRegularSeasonInner());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/regular-season-raw') {
    try {
      const division = url.searchParams.get('division') || 'Academy Mini SZN';
      const text = await withBrowserOp(async () => {
        const browser = await getBrowser();
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 1000 });
        try { return await scrapeRegularSeasonInner(page, division); }
        finally { await page.close(); }
      });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(text);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(e.message);
    }
    return;
  }

  // GET /embed-players?season=<cod-stats season id> -> that season's player stats table
  if (url.pathname === '/embed-players') {
    if (!checkAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const seasonId = url.searchParams.get('season') || '';
    if (!/^[0-9a-f-]{36}$/i.test(seasonId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'season must be a cod-stats season id' }));
      return;
    }
    try {
      const data = await withBrowserOp(() => scrapeEmbedPlayersInner(seasonId));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ season: seasonId, ...data }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /match-stats?game=MW4&season=SZN X Premier[&skip=id,id][&debug=1] -> signed-in match scorecards
  if (url.pathname === '/match-stats') {
    if (!checkAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const season = (url.searchParams.get('season') || '').trim();
    const game = (url.searchParams.get('game') || '').trim();
    if (!season || season.length > 60 || game.length > 10) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'season (tab name) is required' }));
      return;
    }
    const skip = new Set((url.searchParams.get('skip') || '').split(',').filter(x => /^[0-9a-f-]{36}$/i.test(x)));
    try {
      const data = await withBrowserOp(() => scrapeMatchStatsInner({ game, season, skip, debug: url.searchParams.get('debug') === '1' }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/bracket') {
    try {
      const data = await withBrowserOp(() => scrapeAllBracketsInner());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
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
