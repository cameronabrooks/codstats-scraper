const http = require('http');
const { URL } = require('url');
const puppeteer = require('puppeteer');

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || null;
const LEAGUE_PLAYER_URL = 'https://cod-stats.com/amateur-leagues/average-joes-cod-league/player';

async function lookupPlayer(gamertag) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const page = await browser.newPage();
    const url = `${LEAGUE_PLAYER_URL}/${encodeURIComponent(gamertag)}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1800));

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

      const formEls = Array.from(document.querySelectorAll('*')).filter(e =>
        e.children.length === 0 && (e.textContent.trim() === 'W' || e.textContent.trim() === 'L')
      );
      const recentForm = formEls.map(e => e.textContent.trim()).slice(0, 10);

      if (!name && Object.keys(stats).length === 0) return { found: false };

      return { found: true, name, teamName, stats, recentForm };
    });
  } finally {
    await browser.close();
  }
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
