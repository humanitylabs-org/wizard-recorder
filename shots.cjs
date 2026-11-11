// Real wizard-ux shell (routed, no backend) + the real Recorder container under /mizel/ with the live-screen switch on.
// Shoots phone and desktop per skin, the meeting page with its Ask card and the ask sheet. Also STANDALONE=1.
const fs = require('fs'), path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const UX = process.env.UX, APP = process.env.APP || 'http://127.0.0.1:18080', OUT = process.env.OUT || __dirname;
const MID = process.env.MID, ORIGIN = 'http://localhost:9481';
const type = f => /\.m?js$/.test(f) ? 'application/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.html') ? 'text/html' : f.endsWith('.json') ? 'application/json' : f.endsWith('.png') ? 'image/png' : f.endsWith('.webp') ? 'image/webp' : f.endsWith('.jpg') ? 'image/jpeg' : 'image/svg+xml';
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const res = [];
  const runs = process.env.STANDALONE ? [['standalone', 'nebula']] : ['nebula', 'grove'].flatMap(s => [['phone', s], ['desktop', s]]);
  for (const [surface, skin] of runs) {
    const desktop = surface !== 'phone';
    const ctx = await b.newContext({ viewport: desktop ? { width: 1440, height: 900 } : { width: 390, height: 844 }, isMobile: !desktop, hasTouch: !desktop, serviceWorkers: 'block' });
    await ctx.route('**/*', async r => {
      const q = r.request(), u = new URL(q.url()), p = u.pathname, json = (o, s = 200) => r.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(o) });
      if (u.origin !== ORIGIN) return r.abort();
      if (p.startsWith('/mizel/') || p === '/mizel') {
        const resp = await r.fetch({ url: APP + (p.slice('/mizel'.length) || '/') + u.search, headers: { ...q.headers(), origin: APP }, maxRedirects: 0 });
        const loc = resp.headers().location;
        if (loc) return r.fulfill({ status: resp.status(), headers: { location: loc.replace(APP, ORIGIN + '/mizel') } });
        return r.fulfill({ response: resp });
      }
      if (q.method() === 'GET' && p.startsWith('/wizard-os-home/')) {
        let f = p.slice('/wizard-os-home/'.length) || 'index.html'; f = path.join(UX, 'web', f);
        if (fs.existsSync(f) && fs.statSync(f).isFile()) return r.fulfill({ body: fs.readFileSync(f), contentType: type(f) });
        return r.fulfill({ status: 404, body: '' });
      }
      if (p === '/wizard/v1/setup') return json({ first_run: false });
      if (p.endsWith('/bootstrap')) return json({ bootstrap: 1, display: { agent_name: 'Wizard', owner_name: 'Tester' }, endpoints: { apps: '/wizard/v1/apps' } });
      if (p === '/wizard/v1/apps') return json({ apps: [{ id: 'mizel', name: 'Recorder', url: '/mizel/live/', source: 'apps.json', type: 'view', category: 'app' }] });
      if (p.endsWith('/api/sessions')) return json({ sessions: [], has_more: false });
      if (p.endsWith('/agents')) return json({ agents: [{ id: 'hermes', label: 'Wizard', is_default: true, status: 'running' }] });
      if (p.endsWith('/api/jobs')) return json({ jobs: [] });
      if (q.method() !== 'GET') return json({ accepted: true });
      return json({});
    });
    await ctx.addInitScript((skin) => { for (const [k, v] of Object.entries({ 'wos.skin': skin, 'wos.wsync.off': 'true', 'wos.tour.v1': 'true', 'wos.tour.done': '1', 'wos.coached': 'true', 'wos.welcome.v1': 'done' })) localStorage.setItem(k, v); }, skin);
    const p = await ctx.newPage(); const errors = [];
    p.on('pageerror', e => errors.push(String(e)));
    let f;
    if (surface === 'standalone') {
      await p.goto(ORIGIN + '/mizel/live/#/m/' + MID); await p.waitForTimeout(3000); f = p.mainFrame();
    } else {
      await p.goto(ORIGIN + '/wizard-os-home/' + (desktop ? 'desktop.html' : ''));
      await p.waitForFunction(() => !!(window.__wos || window.__wux), null, { timeout: 60000 });
      await p.waitForTimeout(1500);
      await p.evaluate(() => WizCore.deeplink.route('/wizard-os-home/?open=mizel'));
      await p.waitForFunction(() => [...document.querySelectorAll('iframe')].some(f => f.src.includes('/mizel/')), null, { timeout: 30000 });
      await p.waitForTimeout(3000);
      await p.evaluate(() => document.getElementById('wosWelcome')?.remove());
      for (let i = 0; i < 40 && !(f = p.frames().find(f => f.url().includes('/mizel/live/'))); i++) await p.waitForTimeout(500);
      if (!f) { console.log(JSON.stringify({ frames: p.frames().map(x => x.url()), srcs: await p.evaluate(() => [...document.querySelectorAll('iframe')].map(f => f.src)) })); process.exit(2); }
      await f.evaluate((mid) => { location.hash = '#/m/' + mid; }, MID);
    }
    await p.waitForTimeout(3500);
    const name = `${surface}-${skin}`;
    const info = await f.evaluate(() => ({ href: location.href, hosted: !!window.WizardApp?.hosted, orbs: document.querySelectorAll('canvas.agent-mark:not([hidden])').length,
      dots: document.querySelectorAll('.agent-dot').length, agentText: document.body.innerText.match(/Ask \w+|Asked \w+[^\n]*/g)?.slice(0, 3) || [],
      bg: getComputedStyle(document.body).backgroundColor, accent: getComputedStyle(document.documentElement).getPropertyValue('--w-wiz').trim() }));
    await p.screenshot({ path: path.join(OUT, name + '-meeting.png') });
    // Open the ask (answer sheet) from the meeting's Asked list.
    const row = f.locator('.arch-row').first();
    if (await row.count()) { await row.click(); await p.waitForTimeout(1500); await p.screenshot({ path: path.join(OUT, name + '-ask.png') }); }
    info.sheetOrb = await f.evaluate(() => document.querySelectorAll('.ask-sheet canvas.agent-mark:not([hidden])').length);
    res.push({ name, ...info, errors: errors.slice(0, 5) });
    await ctx.close();
  }
  console.log(JSON.stringify(res, null, 2));
  await b.close();
})();
