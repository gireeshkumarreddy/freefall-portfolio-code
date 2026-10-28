// Records a scripted walkthrough of the site, frame by frame, on a virtual clock.
// Every rAF tick, timer, CSS transition and animation advances exactly 1/60 s per
// step, so the recording is smooth no matter how slow each screenshot is.
//
//   node showcase/record.mjs [--seconds N]   (run from the site folder)
//
// Output: showcase/screen.mp4 (the flat 16:9 recording) and showcase/track.json
// (scroll position per frame, used by composite.py to time the sound).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const W = 1650, H = 900, FPS = 30, SUB = 2; // 2 sim steps per frame = 60 Hz
const PORT = 8742, CDP = 9555;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const LIMIT = (() => { const i = process.argv.indexOf('--seconds'); return i > 0 ? +process.argv[i + 1] : Infinity; })();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

// ---------- page-side virtual clock ----------
const VIRTUAL = `(() => {
  let vnow = 0, rafQ = [], timers = [], tid = 1;
  performance.setResourceTimingBufferSize(4000);
  performance.now = () => vnow;
  const t0 = Date.now();
  Date.now = () => t0 + vnow;
  window.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
  window.cancelAnimationFrame = () => {};
  window.setTimeout = (fn, ms, ...args) => { const id = tid++; timers.push({ id, at: vnow + (+ms || 0), fn, args }); return id; };
  window.setInterval = (fn, ms, ...args) => { const id = tid++; timers.push({ id, at: vnow + (+ms || 0), fn, args, every: Math.max(1, +ms || 0) }); return id; };
  window.clearTimeout = window.clearInterval = (id) => { timers = timers.filter((t) => t.id !== id); };
  const mm = window.matchMedia.bind(window);
  const fake = (q, m) => ({ matches: m, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.matchMedia = (q) => (/hover:\\s*hover|pointer:\\s*fine/.test(q) ? fake(q, true) : /hover:\\s*none|pointer:\\s*coarse/.test(q) ? fake(q, false) : mm(q));
  const sync = () => {
    for (const a of document.getAnimations()) {
      if (a.__vs === undefined) { a.__vs = vnow; a.pause(); }
      const t = vnow - a.__vs;
      const end = a.effect ? a.effect.getComputedTiming().endTime : Infinity;
      if (Number.isFinite(end) && t >= end) { try { a.finish(); } catch (e) {} } else a.currentTime = t;
    }
  };
  const tick = (ms) => {
    vnow += ms;
    for (let g = 0; g < 50; g++) {
      const due = timers.filter((t) => t.at <= vnow).sort((a, b) => a.at - b.at);
      if (!due.length) break;
      for (const t of due) {
        if (t.every) t.at += t.every; else timers = timers.filter((x) => x !== t);
        try { typeof t.fn === 'function' ? t.fn(...t.args) : (0, eval)(t.fn); } catch (e) { console.error(e); }
      }
    }
    const q = rafQ; rafQ = [];
    for (const cb of q) { try { cb(vnow); } catch (e) { console.error(e); } }
  };
  window.__v = { tick, sync };
  window.__frame = (ys, ms) => {
    for (const y of ys) {
      if (y !== null && window.freefall) window.freefall.lenis.scrollTo(y, { immediate: true, force: true });
      tick(ms);
    }
    sync();
    return Math.round(scrollY);
  };
})();`;

// ---------- CDP ----------
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome did not start');
}
function client(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    } else if (m.method) listeners.forEach((l) => l(m));
  };
  const ready = new Promise((r) => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { ready, send, on: (l) => listeners.push(l), close: () => ws.close() };
}

// ---------- smooth paths ----------
function monotone(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const n = xs.length, d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (xs[i + 1] < x) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

// ---------- run ----------
const root = process.cwd();
const server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const profile = join(tmpdir(), 'ffrec-' + Date.now());
mkdirSync(profile, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

let cdp, ffmpeg;
const cleanup = () => {
  try { cdp && cdp.close(); } catch {}
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 1500);
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

try {
  await sleep(800);
  cdp = client(await connect());
  await cdp.ready;
  const { send } = cdp;
  cdp.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') console.error('page error:', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await send('Browser.grantPermissions', { origin: `http://127.0.0.1:${PORT}`, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
  await send('Page.addScriptToEvaluateOnNewDocument', { source: VIRTUAL });

  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const loadPage = async () => {
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    for (let i = 0; i < 400; i++) {
      await sleep(250);
      const ok = await evalJS(`(() => { try {
        const r = performance.getEntriesByType('resource');
        const f = r.filter((e) => e.name.includes('/fall/')).length, p = r.filter((e) => e.name.includes('/portal/')).length;
        return !!window.freefall && document.fonts.status === 'loaded' && document.readyState === 'complete' && f >= 465 && p >= 239;
      } catch (e) { return false; } })()`).catch(() => false);
      if (ok) return;
    }
    throw new Error('page did not finish loading');
  };
  const settle = (n = 4) => evalJS(`(() => { for (let i = 0; i < ${n}; i++) __frame([null], 1000/60); return 1; })()`);

  // ---------- probe the layout once ----------
  await loadPage();
  await sleep(300);
  await settle(6);
  const L = await evalJS(`(() => {
    const g = (id) => { const el = document.getElementById(id); return { top: el.offsetTop, h: el.offsetHeight }; };
    return { W: innerWidth, H: innerHeight, docH: document.documentElement.scrollHeight,
      story: g('story'), work: g('work'), about: g('about'), services: g('services'), portal: g('portal'), contact: g('contact'),
      marquee: document.querySelector('.marquee').offsetTop };
  })()`);
  const yStory = (p) => L.story.top + p * (L.story.h - L.H);
  const yWork = (w) => L.work.top + w * (L.work.h - L.H);
  const yPortal = (w) => L.portal.top + w * (L.portal.h - L.H);
  const yEnd = L.docH - L.H;

  const rectAt = async (y, sel) => {
    await evalJS(`__frame([${y}], 1000/60)`);
    await settle(30);
    return evalJS(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width, r.height]; })()`);
  };
  const P = {};
  P.enter = await rectAt(0, '[data-enter="sound"]');
  P.menu = await rectAt(0, '#menuBtn');
  P.cta0 = await rectAt(yWork(0.05), '.screen:nth-of-type(1) .screen-cta');
  P.cta2 = await rectAt(yWork(0.62), '.screen:nth-of-type(3) .screen-cta');
  P.write = await rectAt(yPortal(0.95), '.portal-actions a');
  P.copy = await rectAt(yPortal(0.95), '#copyEmail');
  P.mail = await rectAt(yEnd, '.contact-mail');
  P.again = await rectAt(yEnd, '.contact-again');
  P.items = await evalJS(`[...document.querySelectorAll('.menu-list li')].map((li) => { const r = li.getBoundingClientRect(); return [r.left + Math.min(r.width, 420) * 0.4, r.top + r.height / 2]; })`);
  console.log('layout', JSON.stringify(L));

  // everything on the page is a function of scroll, so returning to the top resets it
  await evalJS('__frame([0], 1000/60)');
  await settle(90);

  // ---------- the walkthrough ----------
  const S = [
    [0, 0], [6.4, 0],
    [8.6, yStory(0.05)],
    [14.5, yStory(0.24)], [21, yStory(0.42)],      // the fall
    [24, yStory(0.47)], [25.3, yStory(0.5)],        // burst and flash
    [28.6, yStory(0.585)], [30.9, yStory(0.65)],    // the noise, the shockwave
    [36.6, yStory(0.86)], [39.4, yStory(0.968)],    // rise, the index assembles
    [42.4, yStory(0.976)], [44.6, yStory(1)],
    [45.8, yWork(0)], [47.4, yWork(0.05)],          // case 1
    [50, yWork(0.3)], [51.3, yWork(0.32)],          // case 2
    [53.8, yWork(0.6)], [55.4, yWork(0.62)],        // case 3
    [57.9, yWork(0.89)], [59.2, yWork(0.94)],       // case 4
    [60.6, yWork(1)],
    [62.4, L.about.top - L.H * 0.15],
    [66.4, L.about.top + L.about.h * 0.5 - L.H * 0.35], // manifesto fully lit
    [68.6, L.marquee - L.H * 0.3],
    [70.6, L.services.top + L.H * 0.05],
    [76.2, L.services.top + L.services.h - L.H * 0.95],
    [78.4, yPortal(0)],
    [81, yPortal(0.2)], [85, yPortal(0.45)], [89.4, yPortal(0.74)], [92, yPortal(0.93)], [94.6, yPortal(0.96)],
    [97, yEnd], [104.05, yEnd],
  ];
  const DRIVE_UNTIL = 103.9; // from here the page scrolls itself after "Fall again" is clicked
  const TOTAL = Math.min(LIMIT, 111);
  const scrollAt = monotone(S);

  const tiles = [[L.W / 2 - 0.3 * L.W, L.H / 2 - 0.25 * L.H], [L.W / 2 + 0.31 * L.W, L.H / 2 + 0.19 * L.H]];
  const M = [
    [0, 1180, 640], [2.4, 1050, 610], [3.15, P.enter[0], P.enter[1]], [3.6, P.enter[0], P.enter[1]],
    [5.2, 1150, 300], [6.6, 520, 560], [9, 300, 300], [13, 1300, 620], [17, 400, 700], [21, 1250, 250],
    [25, 820, 470], [29, 500, 600], [33, 1200, 380], [37.5, 700, 560],
    [40.2, tiles[0][0], tiles[0][1]], [41.3, tiles[0][0] + 6, tiles[0][1] + 4],
    [42.3, tiles[1][0], tiles[1][1]], [43.4, tiles[1][0] - 4, tiles[1][1] + 3],
    [45.4, 900, 520], [46.6, P.cta0[0], P.cta0[1]], [47.6, P.cta0[0] + 10, P.cta0[1] + 2],
    [50, 760, 400], [53.6, 1000, 560], [54.4, P.cta2[0], P.cta2[1]], [55.4, P.cta2[0] + 8, P.cta2[1]],
    [58, 820, 380], [62, 1100, 640], [66, 700, 700], [69, 900, 500],
    [70.8, 520, 230], [72.2, 540, 360], [73.4, 600, 500], [74.6, 620, 640], [75.8, 640, 780], [77, 900, 600],
    [81, 820, 420], [85, 1040, 500], [89, 700, 420],
    [92.4, P.write[0], P.write[1]], [93.1, P.write[0] + 6, P.write[1]],
    [93.6, P.copy[0], P.copy[1]], [94.6, P.copy[0] + 4, P.copy[1]],
    [96.6, P.mail[0], P.mail[1]], [97.4, P.mail[0] + 60, P.mail[1] + 6],
    [98.1, P.menu[0], P.menu[1]], [98.5, P.menu[0], P.menu[1]],
    ...P.items.map((p, i) => [99.2 + i * 0.36, p[0], p[1]]),
    [102.3, P.menu[0] + 30, P.menu[1] + 40], [102.7, P.menu[0], P.menu[1]], [103, P.menu[0], P.menu[1]],
    [103.8, P.again[0], P.again[1]], [104.2, P.again[0], P.again[1]],
    [107, 1100, 500], [111, 900, 480],
  ];
  const mx = monotone(M.map((m) => [m[0], m[1]]));
  const my = monotone(M.map((m) => [m[0], m[2]]));

  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  };
  const events = [
    [0, () => evalJS(`(() => { const l = document.getElementById('loader'); l.classList.remove('is-ready'); document.getElementById('loadPct').textContent = '0'; document.getElementById('loadFill').style.height = '0%'; return 1; })()`)],
    [2.75, () => evalJS(`document.getElementById('loader').classList.add('is-ready')`)],
    [3.45, () => click(P.enter[0], P.enter[1])],
    [94.1, () => click(P.copy[0], P.copy[1])],
    [98.4, () => click(P.menu[0], P.menu[1])],
    [102.85, () => click(P.menu[0], P.menu[1])],
    [104.05, () => click(P.again[0], P.again[1])],
  ];

  mkdirSync(join(root, 'showcase'), { recursive: true });
  ffmpeg = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'showcase/screen.mp4'],
  { cwd: root, stdio: ['pipe', 'inherit', 'inherit'] });

  const frames = Math.round(TOTAL * FPS);
  const track = [];
  let ei = 0, lastMouse = '';
  const started = Date.now();
  for (let f = 0; f < frames; f++) {
    const t = f / FPS;
    while (ei < events.length && events[ei][0] <= t) { await events[ei][1](); ei++; }

    // loader fill, scripted so the video shows it counting up
    if (t >= 0.3 && t <= 2.7) {
      const v = Math.round(clamp((t - 0.3) / 2.3) ** 0.8 * 100);
      await evalJS(`document.getElementById('loadPct').textContent = '${v}'; document.getElementById('loadFill').style.height = '${v}%'`);
    }

    const x = Math.round(mx(t) * 10) / 10, y = Math.round(my(t) * 10) / 10;
    const key = x + ',' + y;
    if (key !== lastMouse) { lastMouse = key; await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }); }

    const ys = [];
    for (let s = 1; s <= SUB; s++) {
      const ts = t - (SUB - s) / (FPS * SUB);
      ys.push(ts <= DRIVE_UNTIL ? Math.round(scrollAt(ts) * 100) / 100 : null);
    }
    const sy = await evalJS(`__frame(${JSON.stringify(ys)}, ${1000 / (FPS * SUB)})`);
    track.push(sy);

    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 93 });
    const buf = Buffer.from(shot.data, 'base64');
    if (!ffmpeg.stdin.write(buf)) await new Promise((r) => ffmpeg.stdin.once('drain', r));

    if (f % 60 === 0) {
      const el = (Date.now() - started) / 1000;
      console.log(`frame ${f}/${frames}  t=${t.toFixed(1)}s  scroll=${sy}  elapsed ${el.toFixed(0)}s  eta ${((el / (f + 1)) * (frames - f - 1)).toFixed(0)}s`);
    }
  }
  ffmpeg.stdin.end();
  await new Promise((r) => ffmpeg.on('close', r));
  writeFileSync(join(root, 'showcase', 'track.json'), JSON.stringify({ fps: FPS, layout: L, scroll: track, clicks: events.slice(2).map((e) => e[0]) }));
  console.log('done', frames, 'frames');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  cleanup();
}
