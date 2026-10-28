/* Freefall: scroll engine for the Arin Vale portfolio.
   One requestAnimationFrame loop reads the scroll position and drives
   both films, the 3D type world and every section after it. */
(() => {
  'use strict';

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const norm = (v, a, b) => clamp((v - a) / (b - a));
  const sstep = (a, b, v) => { const t = norm(v, a, b); return t * t * (3 - 2 * t); };
  const fract = (v) => v - Math.floor(v);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  // 0 → 1 → 0 across [a, b] with the top at `peak`
  const bell = (v, a, peak, b) => (v <= a || v >= b ? 0 : v < peak ? sstep(a, peak, v) : 1 - sstep(peak, b, v));
  const rng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const f1 = (v) => v.toFixed(1);
  const f2 = (v) => v.toFixed(2);

  const html = document.documentElement;
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const S = {
    W: innerWidth, H: innerHeight, y: 0, vel: 0,
    mx: 0, my: 0, smx: 0, smy: 0, cx: innerWidth / 2, cy: innerHeight / 2,
    t: 0, entered: false, lastP: 0,
  };

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  scrollTo(0, 0);

  // ---------- frame sequences ----------
  const FALL_N = 465;   // 15.5 s at 30 fps
  const PORTAL_N = 239; // 10 s at 24 fps

  class Seq {
    constructor(dir, count) {
      this.count = count;
      this.urls = Array.from({ length: count }, (_, i) => `${dir}/${String(i).padStart(3, '0')}.webp`);
      this.imgs = new Array(count);
      this.ok = new Uint8Array(count);
      this.loaded = 0;
      // Coarse-to-fine order, so scrubbing works before every frame has arrived
      const seen = new Uint8Array(count);
      this.order = [];
      const push = (i) => { if (!seen[i]) { seen[i] = 1; this.order.push(i); } };
      push(0);
      for (const s of [32, 16, 8]) for (let i = 0; i < count; i += s) push(i);
      push(count - 1);
      this.gate = this.order.length;
      for (const s of [4, 2, 1]) for (let i = 0; i < count; i += s) push(i);
    }
    load(conc, onTick) {
      let next = 0;
      let gateDone = false;
      let resolveGate;
      const gateP = new Promise((r) => { resolveGate = r; });
      const pump = () => {
        if (next >= this.order.length) return;
        const i = this.order[next++];
        const img = new Image();
        img.decoding = 'async';
        const fin = (ok) => {
          if (ok) { this.imgs[i] = img; this.ok[i] = 1; }
          this.loaded++;
          if (onTick) onTick(Math.min(1, this.loaded / this.gate));
          if (!gateDone && this.loaded >= this.gate) { gateDone = true; resolveGate(); }
          pump();
        };
        // decode ahead of drawing, but never let a stalled decode (background tabs) block the queue
        img.onload = () => { if (img.decode) img.decode().catch(() => {}); fin(true); };
        img.onerror = () => fin(false);
        img.src = this.urls[i];
      };
      for (let k = 0; k < conc; k++) pump();
      return gateP;
    }
    has(i) { return this.ok[i] === 1; }
    get(i) {
      i = clamp(Math.round(i), 0, this.count - 1);
      if (this.ok[i]) return this.imgs[i];
      for (let d = 1; d < this.count; d++) {
        if (i - d >= 0 && this.ok[i - d]) return this.imgs[i - d];
        if (i + d < this.count && this.ok[i + d]) return this.imgs[i + d];
      }
      return null;
    }
  }

  function drawCover(ctx, img, w, h, ax, ay) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const s = Math.max(w / iw, h / ih);
    const dw = iw * s, dh = ih * s;
    ctx.drawImage(img, (w - dw) * ax, (h - dh) * ay, dw, dh);
  }

  // Draws a fractional frame: frame n, then frame n+1 on top at the leftover alpha
  class Film {
    constructor(canvas, seq, ax, ay, maxDpr) {
      this.c = canvas; this.ctx = canvas.getContext('2d', { alpha: false });
      this.seq = seq; this.ax = ax; this.ay = ay; this.maxDpr = maxDpr; this.key = '';
    }
    resize() {
      const r = this.c.getBoundingClientRect();
      const d = Math.min(devicePixelRatio || 1, this.maxDpr);
      this.c.width = Math.max(2, Math.round(r.width * d));
      this.c.height = Math.max(2, Math.round(r.height * d));
      this.key = '';
    }
    render(f) {
      const { seq, ctx, c } = this;
      const i0 = Math.floor(f), fr = f - i0;
      const a = seq.get(i0);
      if (!a) return null;
      const i1 = Math.min(i0 + 1, seq.count - 1);
      const blend = fr > 0.03 && i1 !== i0 && seq.has(i0) && seq.has(i1);
      const key = a.src + (blend ? '|' + fr.toFixed(2) : '');
      if (key === this.key) return a;
      this.key = key;
      ctx.globalAlpha = 1;
      drawCover(ctx, a, c.width, c.height, this.ax, this.ay);
      if (blend) {
        ctx.globalAlpha = fr;
        drawCover(ctx, seq.imgs[i1], c.width, c.height, this.ax, this.ay);
        ctx.globalAlpha = 1;
      }
      return a;
    }
  }

  // Tiny blurred copy of the current frame stretched behind everything
  class Ambient {
    constructor(canvas) { this.c = canvas; this.ctx = canvas.getContext('2d'); this.img = null; }
    resize() { this.c.width = 72; this.c.height = Math.max(2, Math.round(72 * S.H / S.W)); this.img = null; }
    draw(img) {
      if (!img || img === this.img) return;
      this.img = img;
      const { ctx, c } = this;
      ctx.filter = 'blur(3px)';
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, c.width, c.height);
      // scale the frame up so its golden core spreads to the screen edges
      const s = 1.6;
      ctx.save();
      ctx.translate(c.width / 2, c.height / 2);
      ctx.scale(s, 1.1);
      ctx.translate(-c.width / 2, -c.height / 2);
      drawCover(ctx, img, c.width, c.height, 0.5, 0.5);
      ctx.restore();
      ctx.filter = 'none';
    }
  }

  const fall = new Seq('assets/fall', FALL_N);
  const portal = new Seq('assets/portal', PORTAL_N);
  const filmFall = new Film($('#filmCanvas'), fall, 0.5, 0.5, 1.75);
  const filmPortal = new Film($('#portalCanvas'), portal, 0.5, 0.45, 1.5);
  const ambient = new Ambient($('#ambient'));

  // ---------- story timeline (in story progress 0..1) ----------
  const CUT = 0.47;     // hard cut from the shaft to the crowd, hidden in the flash
  const SHOCK = 0.585;  // fire ring leaves the figure
  const FRAME_KEYS = [[0, 0], [0.42, 205], [CUT, 217], [0.58, 270], [0.67, 312], [0.86, 464], [1, 464]];
  const frameAt = (p) => {
    for (let i = 1; i < FRAME_KEYS.length; i++) {
      const [p1, v1] = FRAME_KEYS[i];
      if (p <= p1) { const [p0, v0] = FRAME_KEYS[i - 1]; return lerp(v0, v1, (p - p0) / (p1 - p0)); }
    }
    return FALL_N - 1;
  };

  // ---------- 3D type world ----------
  const WORLD = {
    fall: {
      back: [
        ['Freefall', 'xl ghost'], ['trust the drop', 'serif'], ['Art direction', 'tag'], ['Let go', 'xl'],
        ['the floor is a rumour', 'serif molten'], ['Gravity', 'l ghost molten'], ['Brand identity', 'tag'],
        ['No net', 'xl molten'], ['deadline: yesterday', 'serif'], ['Motion design', 'tag'], ['Light', 'l ghost'],
      ],
      front: [['Fall', 'xxl ghost'], ['Deeper', 'xxl ghost']],
    },
    crowd: {
      back: [
        ['make the logo bigger', 'serif ash'], ['Noise', 'xl ghost ash'], ['can it pop more?', 'serif ash'],
        ['like theirs, but cheaper', 'serif ash'], ['Same', 'l ash'], ["we've always done it this way", 'serif ash'], ['safe', 'm ash'],
        ['by friday?', 'serif ash'], ['Echo', 'l ghost ash'], ['does it have to be weird?', 'serif ash'], ['more blue', 'm ash'],
      ],
      front: [['Noise', 'xxl ghost']],
    },
    rise: {
      back: [
        ['Stand up', 'xl ghost ember'], ['one of one', 'serif'], ['Glow', 'xl molten'], ['still burning', 'serif molten'],
        ['Original', 'l ghost'], ['louder than the room', 'serif'], ['Unmistakable', 'l ember'],
      ],
      front: [],
    },
  };
  const LINES = [
    ['Every idea begins as a fall.', 0.035, 0.17, -0.1],
    ['No net, no brief. Just gravity and instinct.', 0.13, 0.27, 0.12],
    ['You learn the shape of things on the way down.', 0.24, 0.38, -0.08],
    ['Then the light gets louder.', 0.34, 0.47, 0.06],
    ['And you land in the noise.', 0.485, 0.6, 0],
    ['The noise clears. Something is still glowing.', 0.62, 0.74, 0],
    ['Design is whatever is left standing.', 0.765, 0.88, 0],
  ];
  const CTAS = [
    ['See the work', 'work', 'fall', -0.3], ['Start a project', 'contact', 'fall', 0.32],
    ['See the work', 'work', 'rise', 0.3], ['Start a project', 'contact', 'rise', -0.28],
  ];

  const P = 900; // must match .world perspective
  const items = [];
  const rand = rng(11);

  function makeItem(cam, text, kind, o) {
    const el = document.createElement(o.jump ? 'a' : 'div');
    el.className = 'wi ' + kind;
    const span = document.createElement('span');
    span.textContent = text;
    el.appendChild(span);
    if (o.jump) {
      el.href = '#' + o.jump;
      el.dataset.jump = o.jump;
      el.dataset.cursor = 'Go';
    }
    cam.appendChild(el);
    items.push(Object.assign({ el, vis: false, ry: 0 }, o));
  }

  function buildWorld() {
    const back = $('.world--back .cam'), front = $('.world--front .cam'), ui = $('.world--ui .cam');
    for (const [set, def] of Object.entries(WORLD)) {
      def.back.forEach(([text, kind], i, arr) => {
        const side = i % 2 ? 1 : -1;
        const depth = rand();
        makeItem(back, text, kind, {
          set, loop: true, depth,
          xs: side * (0.16 + rand() * 0.28),
          z: -120 - depth * 1300, zIn: 260, zOut: -700,
          rate: lerp(1.15, 0.6, depth), phase: i / arr.length + rand() * 0.03,
          ry: Math.round((rand() * 22 + 6) * -side),
        });
      });
      // big outlined words that rush past the lens, mostly off the figure
      def.front.forEach(([text, kind], i, arr) => {
        makeItem(front, text, kind, {
          set, loop: true, depth: 0,
          xs: (i % 2 ? 1 : -1) * (0.12 + rand() * 0.12),
          z: 60, zIn: 320, zOut: -260,
          rate: 2.2, phase: i / arr.length + 0.17, cap: 0.75,
          ry: Math.round((rand() - 0.5) * 20),
        });
      });
    }
    LINES.forEach(([text, p0, p1, xs]) => {
      makeItem(front, text, 'line', { set: 'line', loop: false, p0, p1, xs, z: 0, zIn: 180, zOut: -420 });
    });
    CTAS.forEach(([text, jump, set, xs], i) => {
      makeItem(ui, text, 'cta', {
        set: 'ui-' + set, loop: true, jump, xs,
        z: -60, zIn: 200, zOut: -420, rate: 0.55, phase: i * 0.5 + 0.12,
        ry: xs > 0 ? -14 : 14,
      });
    });
  }

  function placeWorld(p, travel, alpha, shockT) {
    const { W, H } = S;
    const stretch = 1 + Math.min(Math.abs(S.vel), 70) * 0.004;
    const skew = clamp(S.vel * 0.05, -5, 5);
    for (const it of items) {
      let a = alpha[it.set] || 0;
      let t;
      if (it.loop) t = fract(it.phase + travel * it.rate);
      else { t = (p - it.p0) / (it.p1 - it.p0); if (t <= 0 || t >= 1) a = 0; }
      if (a > 0) a *= sstep(0, 0.1, t) * (1 - sstep(0.86, 1, t)) * (it.cap || 1) * (1 - (it.depth || 0) * 0.55);

      let z = it.z + lerp(it.zIn, it.zOut, t);
      let xs = it.xs, rz = 0;
      if (it.set === 'crowd' && shockT > 0) {
        // the fire ring blows the crowd's voices out of frame
        const dir = xs >= 0 ? 1 : -1;
        const e = easeOut(shockT);
        xs += dir * (0.35 + Math.abs(xs)) * e * 1.2;
        z += e * 650;
        rz = dir * e * 38;
        a *= 1 - shockT;
      }
      if (a <= 0.004) {
        if (it.vis) { it.el.style.visibility = 'hidden'; it.vis = false; }
        continue;
      }
      if (!it.vis) { it.el.style.visibility = 'visible'; it.vis = true; }
      z = Math.min(z, P - 140);
      const k = (P - z) / P;
      const x = xs * W * k;
      const y = lerp(0.72, -0.72, t) * H * k;
      const rx = lerp(-16, 34, t);
      it.el.style.opacity = f2(a);
      it.el.style.transform =
        `translate3d(${f1(x)}px,${f1(y)}px,${f1(z)}px) rotateX(${f2(rx)}deg) rotateY(${it.ry}deg) rotateZ(${f2(rz)}deg) skewY(${f2(skew)}deg) scaleY(${stretch.toFixed(3)})`;
    }
  }

  // ---------- DOM refs ----------
  const stageInner = $('.stage-inner');
  const filmEl = $('#film');
  const vignette = $('.vignette');
  const ambientEl = $('#ambient');
  const cams = $$('.world .cam');
  const hero = $('#hero');
  const flash = $('.flash:not(.flash--ember)');
  const flashWord = $('.flash b');
  const flashEmber = $('.flash--ember');
  const shock = $('.shock');
  const riseEls = $$('.rise span');
  const riseSeeds = riseEls.map((_, i) => ({
    x: (i - 1.5) * 0.5 + (rand() - 0.5) * 0.3, y: (rand() - 0.5) * 1.2, rx: (rand() - 0.5) * 160, ry: (rand() - 0.5) * 120,
  }));
  const indexName = $('.index-name');
  const tilesEl = $('#tiles');
  const tiles = $$('.tile', tilesEl).map((el) => ({
    el, x: +el.dataset.x, y: +el.dataset.y, s: +el.dataset.s, ar: +el.dataset.ar, z: +el.dataset.z, d: +el.dataset.d, vis: false,
  }));
  const hud = $('.hud');
  const hudNum = $('.hud-num'), hudName = $('.hud-name'), hudRead = $('.hud-read'), hudBar = $('.hud-bar i');

  const screens = $$('.screen').map((el) => ({
    el, title: $('.screen-title span', el), face: $('.disc-face', el), ring: $('.disc-ring', el), vis: true,
  }));
  const portalCanvas = $('#portalCanvas');
  const tunnelCam = $('.tunnel-cam');
  const portalLines = $$('.portal-line').map((el) => {
    const [a, b] = el.dataset.w.split(',').map(Number);
    return { el, a, b };
  });
  const portalCta = $('.portal-cta');

  const layout = {};
  let baseFeather = 18;

  // ---------- arches for the portal tunnel ----------
  const arches = [];
  (() => {
    const words = ['step through', '', 'this way', '', 'come in', '', 'step through', '', 'almost there', ''];
    words.forEach((w) => {
      const el = document.createElement('div');
      el.className = 'arch';
      if (w) { const s = document.createElement('span'); s.textContent = w; el.appendChild(s); }
      tunnelCam.appendChild(el);
      arches.push({ el });
    });
  })();

  // ---------- manifesto words ----------
  const manifesto = $('#manifesto');
  const words = [];
  (() => {
    const text = manifesto.textContent.trim().split(/\s+/);
    manifesto.textContent = '';
    text.forEach((w, i) => {
      const s = document.createElement('span');
      s.className = 'w';
      s.textContent = w;
      manifesto.appendChild(s);
      if (i < text.length - 1) manifesto.appendChild(document.createTextNode(' '));
      words.push({ el: s, o: -1 });
    });
  })();

  // ---------- marquee ----------
  const marquees = $$('.marquee-row').map((row) => {
    const track = $('.marquee-track', row);
    const clone = track.innerHTML;
    track.insertAdjacentHTML('beforeend', clone);
    $$('span', track).slice(track.children.length / 2).forEach((s) => s.setAttribute('aria-hidden', 'true'));
    return { track, dir: +row.dataset.dir, x: 0, half: 0 };
  });

  // ---------- services preview ----------
  const svcPreview = $('.svc-preview');
  const svcImg = $('img', svcPreview);
  const pv = { x: S.W / 2, y: S.H / 2, on: false, s: 0.6 };
  $$('.svc').forEach((li) => {
    li.addEventListener('mouseenter', () => { svcImg.src = li.dataset.img; pv.on = true; svcPreview.classList.add('is-on'); Sound.tick(); });
  });
  $('.svc-list').addEventListener('mouseleave', () => { pv.on = false; svcPreview.classList.remove('is-on'); });

  // ---------- measure ----------
  function measure() {
    S.W = innerWidth; S.H = innerHeight;
    for (const id of ['story', 'work', 'about', 'services', 'portal', 'contact']) {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      layout[id] = { top: r.top + scrollY, h: r.height };
    }
    filmFall.resize(); filmPortal.resize(); ambient.resize();
    baseFeather = S.W / S.H < 0.8 ? 0 : 22;

    const base = Math.min(S.H, S.W * 1.25);
    tiles.forEach((tl) => {
      const w = tl.s * base;
      tl.el.style.width = f1(w) + 'px';
      tl.el.style.height = f1(w / tl.ar) + 'px';
    });

    // the fire ring sits where the figure lands in the crowd shot (43% down the frame)
    const fw = Math.min(S.W, S.H * 0.72), fh = S.H;
    const sc = Math.max(fw / 720, fh / 1280);
    const dh = 1280 * sc;
    shock.style.top = f1((fh - dh) / 2 + 0.43 * dh) + 'px';

    // the portal's centre in the walk-out shot
    const ps = Math.max(S.W / 1600, S.H / 900);
    const pdh = 900 * ps;
    tunnelCam.style.top = f1((S.H - pdh) * 0.45 + 0.44 * pdh) + 'px';

    marquees.forEach((m) => { m.half = m.track.scrollWidth / 2; });
  }

  // ---------- story update ----------
  function updateStory() {
    const L = layout.story;
    if (S.y > L.top + L.h) return;
    const p = clamp((S.y - L.top) / (L.h - S.H));
    const { W, H } = S;

    // film + ambient
    const img = filmFall.render(frameAt(p));
    if (img) ambient.draw(img);

    // camera follows the pointer
    const camT = `rotateX(${f2(-S.smy * 7)}deg) rotateY(${f2(S.smx * 10)}deg)`;
    for (const c of cams) c.style.transform = camT;

    // the type world
    const travel = (S.y - L.top) / H * 0.2 + S.t * 0.004;
    const shockT = norm(p, SHOCK, 0.64);
    const alpha = {
      fall: sstep(0.02, 0.06, p) * (1 - sstep(CUT - 0.03, CUT, p)),
      crowd: sstep(CUT, CUT + 0.03, p),
      rise: sstep(0.655, 0.7, p) * (1 - sstep(0.84, 0.875, p)),
      line: 1,
      'ui-fall': sstep(0.04, 0.07, p) * (1 - sstep(0.42, 0.45, p)),
      'ui-rise': sstep(0.68, 0.71, p) * (1 - sstep(0.84, 0.87, p)),
    };
    placeWorld(p, travel, alpha, shockT);

    // hero tips backwards into the shaft
    const he = sstep(0, 0.05, p);
    hero.style.transform = `perspective(900px) translate3d(0,${f1(-he * 26)}vh,${f1(-he * 700)}px) rotateX(${f1(he * 48)}deg)`;
    hero.style.opacity = f2(1 - sstep(0.012, 0.05, p));
    hero.style.visibility = p > 0.06 ? 'hidden' : 'visible';

    // impact flash at the cut
    const fl = bell(p, 0.435, CUT, 0.51);
    flash.style.opacity = f2(fl);
    if (fl > 0) {
      flashWord.style.opacity = f2(bell(p, 0.452, CUT, 0.492));
      flashWord.style.transform = `scale(${f2(lerp(0.72, 1.28, norm(p, 0.44, 0.51)))})`;
      stageInner.style.transform = fl > 0.2 && !reduce
        ? `translate(${f1((Math.random() - 0.5) * 18 * fl)}px,${f1((Math.random() - 0.5) * 18 * fl)}px)` : '';
    } else if (stageInner.style.transform) stageInner.style.transform = '';

    // fire ring shockwave
    flashEmber.style.opacity = f2(bell(p, SHOCK - 0.004, SHOCK + 0.01, 0.625) * 0.42);
    if (shockT > 0 && shockT < 1) {
      const e = easeOut(shockT);
      shock.style.opacity = f2((1 - shockT) * sstep(0, 0.06, shockT));
      shock.style.transform = `scale(${f2(lerp(0.12, 7.5, e))}, ${f2(lerp(0.12, 7.5, e) * 0.5)})`;
    } else shock.style.opacity = '0';

    // R I S E assembles out of the depth, then tips back and away
    const rq = norm(p, 0.685, 0.8), ex = sstep(0.815, 0.865, p);
    riseEls.forEach((el, i) => {
      const lt = easeOut(norm(rq, i * 0.1, i * 0.1 + 0.6));
      if (lt <= 0 || ex >= 1) { el.style.opacity = '0'; return; }
      const r = riseSeeds[i];
      const tx = lerp(r.x * W, 0, lt), ty = lerp(r.y * H, 0, lt) - ex * H * 0.5;
      const tz = lerp(-2600, 0, lt) - ex * 1600;
      el.style.transform = `translate3d(${f1(tx)}px,${f1(ty)}px,${f1(tz)}px) rotateX(${f1(lerp(r.rx, 0, lt) + ex * 55)}deg) rotateY(${f1(lerp(r.ry, 0, lt))}deg)`;
      el.style.opacity = f2(lt * (1 - ex));
    });

    // index: the film shrinks into one tile among the work
    const iq = easeInOut(norm(p, 0.86, 0.97));
    const drift = norm(p, 0.975, 1);
    filmEl.style.transform = `translateX(-50%) translate3d(${f1(S.smx * -14 * iq)}px,${f1(-drift * H * 0.08)}px,0) scale(${(lerp(1, 0.36, iq)).toFixed(4)})`;
    filmEl.style.setProperty('--f', f1(lerp(baseFeather, 0, iq)) + '%');
    vignette.style.opacity = f2(1 - iq * 0.7);
    ambientEl.style.opacity = f2(0.5 * (1 - iq * 0.75));

    const q = norm(p, 0.865, 0.975);
    indexName.style.opacity = f2(q * 0.9);
    if (q > 0) indexName.style.transform = `translate(-50%,-50%) translate3d(${f1(S.smx * -26)}px,${f1(S.smy * -14 - drift * H * 0.1)}px,0) scale(${f2(lerp(1.35, 1, easeOut(q)))})`;
    tilesEl.classList.toggle('is-live', q > 0.7);
    const TP = 1200;
    for (const tl of tiles) {
      const tq = easeOut(norm(q, tl.d, tl.d + 0.55));
      if (tq <= 0) { if (tl.vis) { tl.el.style.opacity = '0'; tl.vis = false; } continue; }
      tl.vis = true;
      const z = lerp(-3200, tl.z, tq) + drift * 500 * (1 + tl.d);
      const k = (TP - z) / TP;
      const x = tl.x * W * k + S.smx * (30 + tl.d * 90);
      const y = (tl.y * H - drift * H * (0.12 + tl.d * 0.2)) * k + S.smy * (20 + tl.d * 60);
      tl.el.style.opacity = f2(tq);
      tl.el.style.transform = `translate(-50%,-50%) translate3d(${f1(x)}px,${f1(y)}px,${f1(z)}px) rotateY(${f2(S.smx * -9)}deg) rotateX(${f2(S.smy * 7)}deg)`;
    }

    // one-shot hits when crossing the cut and the shockwave going down
    if (S.lastP < CUT && p >= CUT && p - S.lastP < 0.05) impact(1);
    if (S.lastP < SHOCK && p >= SHOCK && p - S.lastP < 0.05) impact(0.7);
    S.lastP = p;
    S.storyP = p;
  }

  function impact(power) {
    if (!reduce) {
      stageInner.classList.remove('is-shake');
      void stageInner.offsetWidth;
      stageInner.classList.add('is-shake');
    }
    hud.classList.remove('is-pulse');
    void hud.offsetWidth;
    hud.classList.add('is-pulse');
    Sound.boom(power);
  }

  // ---------- work: stacked screens that slide in and recede backwards ----------
  function updateWork() {
    const L = layout.work;
    if (S.y + S.H < L.top || S.y > L.top + L.h) return;
    const w = clamp((S.y - L.top) / (L.h - S.H));
    const n = screens.length;
    const k = norm(w, 0, 0.88) * (n - 1);
    S.workCase = Math.round(k);
    screens.forEach((sc, i) => {
      const d = k - i;
      if (d < -1 || d > 2.4) {
        if (sc.vis) { sc.el.style.visibility = 'hidden'; sc.vis = false; }
        return;
      }
      if (!sc.vis) { sc.el.style.visibility = 'visible'; sc.vis = true; }
      let ty = 0, tz = 0, rx = 0, rz = 0, dim = 0;
      const side = i % 2 ? 1 : -1;
      if (d < 0) {
        const e = easeOut(d + 1);
        ty = (1 - e) * 115; rx = (1 - e) * 24; rz = (1 - e) * 7 * side;
      } else {
        const r = d;
        tz = -r * 420; ty = -r * 6; rz = -r * 2.6 * side; rx = r * 5;
        dim = Math.min(r, 1.4) * 0.6;
      }
      sc.el.style.transform = `translate3d(0,${f2(ty)}%,${f1(tz)}px) rotateX(${f2(rx)}deg) rotateZ(${f2(rz)}deg)`;
      sc.el.style.setProperty('--dim', f2(dim));
      const local = clamp((d + 1) / 2.4);
      sc.title.style.transform = `translate3d(${f2(lerp(4, -42, local))}%,0,0) skewX(${f2(clamp(-S.vel * 0.12, -12, 12))}deg)`;
      sc.face.style.transform = `rotate(${f1(S.y * 0.09 + i * 50)}deg)`;
      sc.ring.style.transform = `rotate(${f1(-S.y * 0.05)}deg)`;
    });
  }

  // ---------- about ----------
  function updateAbout() {
    const L = layout.about;
    if (S.y + S.H < L.top || S.y > L.top + L.h) return;
    const m = norm(S.y, L.top - S.H * 0.7, L.top + L.h * 0.5 - S.H * 0.35);
    const N = words.length;
    const head = m * (N + 5);
    for (let i = 0; i < N; i++) {
      const o = Math.round(lerp(0.13, 1, clamp((head - i) / 5)) * 50) / 50;
      if (o !== words[i].o) { words[i].o = o; words[i].el.style.opacity = o; }
    }
  }

  // ---------- marquee: speeds up and flips with your scroll ----------
  let marqueeDir = 1;
  function updateMarquee(dt) {
    if (Math.abs(S.vel) > 0.5) marqueeDir = S.vel > 0 ? 1 : -1;
    const speed = (reduce ? 0 : 0.7) + Math.min(Math.abs(S.vel), 80) * 0.35;
    for (const m of marquees) {
      if (!m.half) continue;
      m.x += speed * m.dir * marqueeDir * (dt / 16.67);
      if (m.x <= -m.half) m.x += m.half;
      if (m.x > 0) m.x -= m.half;
      m.track.style.transform = `translate3d(${f1(m.x)}px,0,0)`;
    }
  }

  // ---------- services hover preview ----------
  function updateServices() {
    if (!fine) return;
    const L = layout.services;
    if (S.y + S.H < L.top || S.y > L.top + L.h) return;
    const px = pv.x;
    pv.x = lerp(pv.x, S.cx, 0.14);
    pv.y = lerp(pv.y, S.cy, 0.14);
    pv.s = lerp(pv.s, pv.on ? 1 : 0.6, 0.12);
    const rot = clamp((pv.x - px) * 0.6, -14, 14);
    const w = svcPreview.offsetWidth, h = svcPreview.offsetHeight;
    svcPreview.style.transform = `translate3d(${f1(pv.x - w / 2)}px,${f1(pv.y - h / 2)}px,0) rotate(${f2(rot)}deg) scale(${f2(pv.s)})`;
  }

  // ---------- portal: he walks out, the tunnel flies past you ----------
  function updatePortal() {
    const L = layout.portal;
    if (S.y + S.H < L.top || S.y > L.top + L.h) { S.portalOpen = 0; return; }
    const w = clamp((S.y - L.top) / (L.h - S.H));
    filmPortal.render(norm(w, 0.02, 0.76) * (PORTAL_N - 1));

    const push = sstep(0.76, 1, w);
    portalCanvas.style.transform = `scale(${(1 + push * 0.32).toFixed(4)}) translate3d(${f1(S.smx * -10)}px,${f1(S.smy * -8)}px,0)`;

    // the tunnel shows while the door opens, steps aside while he walks out,
    // then returns and speeds up as you push through the door yourself
    const open = Math.max(sstep(0.1, 0.24, w) * (1 - sstep(0.4, 0.52, w)), sstep(0.78, 0.9, w));
    S.portalOpen = Math.max(open, sstep(0.1, 0.3, w) * (1 - sstep(0.9, 1, w)));
    const rush = w * 2.4 + push * 3;
    for (let i = 0; i < arches.length; i++) {
      const a = arches[i];
      const z = -3600 + fract(i / arches.length + rush + S.t * 0.012) * 4300;
      const o = open * sstep(-3600, -2300, z) * (1 - sstep(220, 680, z));
      a.el.style.opacity = f2(o);
      if (o > 0) a.el.style.transform = `translate3d(${f1(S.smx * -40)}px,${f1(S.smy * -26)}px,${f1(z)}px)`;
    }

    for (const l of portalLines) {
      const t = norm(w, l.a, l.b);
      const o = sstep(0, 0.25, t) * (1 - sstep(0.75, 1, t));
      l.el.style.opacity = f2(o);
      l.el.style.transform = `translate3d(-50%,${f1(lerp(50, -50, t))}px,0)`;
    }

    const c = sstep(0.8, 0.9, w);
    portalCta.style.opacity = f2(c);
    portalCta.style.transform = `translateY(${f1((1 - c) * 50)}px)`;
    portalCta.classList.toggle('is-live', c > 0.5);
  }

  // ---------- HUD ----------
  const CHAPTERS = ['The leap', 'Impact', 'The noise', 'Rise', 'Index', 'Selected work', 'About', 'Services', 'The portal', 'Contact'];
  const hudState = { ch: -1, read: '', bar: -1 };
  const fmtAlt = (v) => Math.round(v).toLocaleString('en-US').replace(/,/g, ' ');
  function updateHud() {
    const L = layout.story;
    const mid = S.y + S.H * 0.5;
    const p = clamp((S.y - L.top) / (L.h - S.H));
    let ch;
    if (mid < L.top + L.h) ch = p < 0.44 ? 0 : p < 0.5 ? 1 : p < 0.66 ? 2 : p < 0.86 ? 3 : 4;
    else if (mid < layout.about.top) ch = 5;
    else if (mid < layout.services.top) ch = 6;
    else if (mid < layout.portal.top) ch = 7;
    else if (mid < layout.contact.top) ch = 8;
    else ch = 9;

    if (ch !== hudState.ch) {
      hudState.ch = ch;
      hudNum.textContent = String(ch + 1).padStart(2, '0');
      hudName.textContent = CHAPTERS[ch];
    }
    const total = document.documentElement.scrollHeight - S.H;
    const pct = clamp(S.y / total);
    let read;
    if (ch <= 1) read = `Altitude ${fmtAlt(lerp(12400, 0, clamp(p / CUT)))} m`;
    else if (ch <= 3) read = 'Ground level';
    else if (ch === 4) read = 'Index of work';
    else if (ch === 5) read = `Case ${(S.workCase || 0) + 1} of 4`;
    else read = `${Math.round(pct * 100)}% down`;
    if (read !== hudState.read) { hudState.read = read; hudRead.textContent = read; }
    const b = Math.round(pct * 1000);
    if (b !== hudState.bar) { hudState.bar = b; hudBar.style.transform = `scaleX(${b / 1000})`; }
  }

  // ---------- cursor ----------
  const cursor = $('.cursor');
  const cDot = $('.cursor-dot'), cRing = $('.cursor-ring'), cLabel = $('.cursor-ring span');
  const ring = { x: S.cx, y: S.cy };
  let cursorTarget = null;
  if (fine) html.classList.add('has-cursor');
  addEventListener('pointermove', (e) => {
    S.cx = e.clientX; S.cy = e.clientY;
    S.mx = (e.clientX / S.W) * 2 - 1;
    S.my = (e.clientY / S.H) * 2 - 1;
  }, { passive: true });
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest && e.target.closest('[data-cursor]');
    if (t === cursorTarget) return;
    cursorTarget = t;
    if (t) { cLabel.textContent = t.dataset.cursor; cursor.classList.add('is-label'); Sound.tick(); }
    else cursor.classList.remove('is-label');
  });
  addEventListener('pointerdown', () => cursor.classList.add('is-down'));
  addEventListener('pointerup', () => cursor.classList.remove('is-down'));
  function updateCursor() {
    if (!fine) return;
    ring.x = lerp(ring.x, S.cx, 0.2);
    ring.y = lerp(ring.y, S.cy, 0.2);
    cDot.style.transform = `translate3d(${f1(S.cx)}px,${f1(S.cy)}px,0)`;
    cRing.style.transform = `translate3d(${f1(ring.x)}px,${f1(ring.y)}px,0)`;
  }

  // ---------- magnetic buttons ----------
  if (fine) {
    $$('.magnet').forEach((el) => {
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
        el.classList.add('is-pull');
        el.style.transform = `translate(${f1(x * 0.22)}px,${f1(y * 0.34)}px)`;
      });
      el.addEventListener('pointerleave', () => { el.classList.remove('is-pull'); el.style.transform = ''; });
    });
  }

  // ---------- sound: synthesised, so it can follow your scroll ----------
  const Sound = {
    ctx: null, on: false,
    init() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      const c = (this.ctx = new AC());
      this.master = c.createGain();
      this.master.gain.value = 0;
      this.master.connect(c.destination);

      const len = c.sampleRate * 2;
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;

      const src = c.createBufferSource();
      src.buffer = buf; src.loop = true;
      this.windF = c.createBiquadFilter();
      this.windF.type = 'bandpass'; this.windF.frequency.value = 400; this.windF.Q.value = 0.8;
      this.windG = c.createGain(); this.windG.gain.value = 0;
      src.connect(this.windF).connect(this.windG).connect(this.master);
      src.start();

      this.droneLP = c.createBiquadFilter();
      this.droneLP.type = 'lowpass'; this.droneLP.frequency.value = 300;
      this.droneG = c.createGain(); this.droneG.gain.value = 0;
      [55, 55.6, 82.4, 110.3].forEach((f) => {
        const o = c.createOscillator();
        o.type = 'sawtooth'; o.frequency.value = f;
        o.connect(this.droneLP); o.start();
      });
      this.droneLP.connect(this.droneG).connect(this.master);
      return true;
    },
    set(on) {
      if (on && !this.ctx && !this.init()) return;
      this.on = on;
      if (this.ctx) {
        if (on) this.ctx.resume();
        this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ctx.currentTime, 0.25);
      }
      const btn = $('#soundBtn');
      btn.setAttribute('aria-pressed', String(on));
      $('span', btn).textContent = on ? 'Sound on' : 'Sound off';
      html.classList.toggle('sound-on', on);
    },
    update() {
      if (!this.on) return;
      const t = this.ctx.currentTime;
      const v = Math.min(Math.abs(S.vel), 80) / 80;
      const st = layout.story;
      const inStory = S.y < st.top + st.h;
      const p = S.storyP || 0;
      let wind = 0.02 + v * 0.35, freq = 260 + v * 900;
      if (inStory && p < CUT) { wind = 0.06 + v * 0.6; freq = 380 + v * 1500 + p * 600; }
      else if (inStory && p < 0.86) { wind = 0.04 + v * 0.3; freq = 180 + v * 400; }
      this.windG.gain.setTargetAtTime(wind, t, 0.08);
      this.windF.frequency.setTargetAtTime(freq, t, 0.12);
      const open = S.portalOpen || 0;
      this.droneG.gain.setTargetAtTime(open * 0.09, t, 0.4);
      this.droneLP.frequency.setTargetAtTime(220 + open * 900, t, 0.4);
    },
    boom(power) {
      if (!this.on) return;
      const c = this.ctx, t = c.currentTime;
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(30, t + 1.2);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.9 * power, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.7);
      o.connect(g).connect(this.master);
      o.start(t); o.stop(t + 1.8);
      const n = c.createBufferSource();
      n.buffer = this.noise;
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(4000, t);
      f.frequency.exponentialRampToValueAtTime(120, t + 1);
      const ng = c.createGain();
      ng.gain.setValueAtTime(0.5 * power, t);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      n.connect(f).connect(ng).connect(this.master);
      n.start(t); n.stop(t + 1.2);
    },
    tick() {
      if (!this.on) return;
      const c = this.ctx, t = c.currentTime;
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(1800, t);
      o.frequency.exponentialRampToValueAtTime(900, t + 0.05);
      const g = c.createGain();
      g.gain.setValueAtTime(0.05, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      o.connect(g).connect(this.master);
      o.start(t); o.stop(t + 0.08);
    },
  };
  $('#soundBtn').addEventListener('click', () => Sound.set(!Sound.on));

  // ---------- smooth scroll ----------
  const lenis = typeof window.Lenis === 'function'
    ? new window.Lenis({
      duration: 1.3,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: !reduce,
      wheelMultiplier: 0.85,
      touchMultiplier: 1.4,
    })
    : null;
  if (lenis) lenis.stop();
  // handy from the console: freefall.jump('work'), freefall.step() renders one frame
  window.freefall = { lenis, jump: (key) => jump(key), step: () => step(performance.now()) };

  // ---------- navigation ----------
  const menu = $('#menu');
  const menuBtn = $('#menuBtn');
  const menuImg = $('.menu-preview img');
  function setMenu(open) {
    html.classList.toggle('menu-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-hidden', String(!open));
    menuBtn.textContent = open ? 'Close' : 'Menu';
    if (lenis && S.entered) open ? lenis.stop() : lenis.start();
  }
  menuBtn.addEventListener('click', () => setMenu(!html.classList.contains('menu-open')));
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && html.classList.contains('menu-open')) setMenu(false); });
  $$('.menu-list a').forEach((a) => a.addEventListener('pointerenter', () => { menuImg.src = a.dataset.img; }));

  function targetY(key) {
    if (key === 'top') return 0;
    if (key.startsWith('story:')) {
      const L = layout.story;
      return L.top + parseFloat(key.slice(6)) * (L.h - S.H);
    }
    if (key.startsWith('case:')) {
      const L = layout.work;
      const i = +key.slice(5);
      return L.top + (i / (screens.length - 1)) * 0.88 * (L.h - S.H);
    }
    if (key === 'contact') return document.documentElement.scrollHeight - S.H;
    return layout[key] ? layout[key].top : 0;
  }
  function jump(key) {
    if (!S.entered) return;
    const y = targetY(key);
    const dist = Math.abs(y - scrollY);
    if (lenis) lenis.scrollTo(y, { duration: clamp((dist / S.H) * 0.22, 1.2, 5), easing: easeInOut, force: true });
    else scrollTo({ top: y, behavior: reduce ? 'auto' : 'smooth' });
  }
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    const a = e.target.closest('[data-jump]');
    if (!go && !a) return;
    e.preventDefault();
    if (html.classList.contains('menu-open')) setMenu(false);
    if (go) {
      const g = go.dataset.go;
      jump(/^\d+$/.test(g) ? 'case:' + g : g);
    } else jump(a.dataset.jump);
  });

  // copy email
  const copyBtn = $('#copyEmail');
  copyBtn.addEventListener('click', async () => {
    const email = copyBtn.dataset.email;
    try { await navigator.clipboard.writeText(email); copyBtn.textContent = 'Copied'; }
    catch { copyBtn.textContent = email; }
    setTimeout(() => { copyBtn.textContent = 'Copy email'; }, 2200);
  });

  // Lisbon clock
  const clock = $('#clock');
  const tick = () => {
    try { clock.textContent = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Lisbon' }).format(new Date()); }
    catch { clock.textContent = new Date().toTimeString().slice(0, 5); }
  };
  tick(); setInterval(tick, 15000);

  // ---------- loader + enter ----------
  const loader = $('#loader');
  const loadPct = $('#loadPct'), loadFill = $('#loadFill');
  $$('.hn').forEach((el, i) => { el.style.transitionDelay = `${0.25 + i * 0.055}s`; });

  function enter(withSound) {
    if (S.entered) return;
    S.entered = true;
    if (withSound) Sound.set(true);
    loader.classList.add('is-out');
    document.body.classList.remove('is-locked');
    html.classList.add('is-entered');
    if (lenis) lenis.start();
    measure();
    setTimeout(() => loader.remove(), 1300);
  }
  $$('[data-enter]').forEach((b) => b.addEventListener('click', () => enter(b.dataset.enter === 'sound')));

  fall.load(8, (r) => {
    const v = Math.round(r * 100);
    loadPct.textContent = v;
    loadFill.style.height = v + '%';
  }).then(() => {
    portal.load(3);
    loader.classList.add('is-ready');
    const first = $('[data-enter="sound"]');
    if (first && !S.entered) first.focus({ preventScroll: true });
  });

  // ---------- main loop ----------
  buildWorld();
  measure();
  addEventListener('resize', () => { clearTimeout(measure.t); measure.t = setTimeout(measure, 120); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  addEventListener('load', measure);

  let last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    step(now);
  }
  function step(now) {
    const dt = Math.min(64, now - last);
    last = now;
    if (lenis) lenis.raf(now);
    const y = window.scrollY;
    S.vel = lerp(S.vel, y - S.y, 0.3);
    S.y = y;
    S.t = now / 1000;
    if (!fine) { S.mx = Math.sin(S.t * 0.4) * 0.35; S.my = Math.cos(S.t * 0.3) * 0.25; }
    S.smx = lerp(S.smx, S.mx, 0.06);
    S.smy = lerp(S.smy, S.my, 0.06);

    updateStory();
    updateWork();
    updateAbout();
    updateMarquee(dt);
    updateServices();
    updatePortal();
    updateHud();
    updateCursor();
    Sound.update();
  }
  requestAnimationFrame(loop);
})();
