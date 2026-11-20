/* Scenes S1–S5 (0.0–23.5 s), builder A, storyboard v2.
 *
 * How time is handled here. The film is rendered by seeking, so every visible state is a pure
 * function of the film time t. Everything in this file is driven from FILM.hooks: a hook computes
 * a value directly from t (a position on a track of eased segments, a text, a class, a cut), so a
 * frame is the same whether it is reached forwards or backwards, and an event at time T is already
 * visible on the frame at exactly T. There are no GSAP tweens here; GSAP only supplies the eases.
 * Transforms are written as plain 2D values and no element keeps a compositor layer (see the
 * will-change note in scenes-a.css): a cached layer would make a frame's pixels depend on which
 * frames were rendered before it.
 */
(function () {
  const h = FILM.h, G = FILM.SHELF;

  /* =====================================================================================
   * S1 GEOMETRY — the hook's layout, in stage pixels at world scale 1.00.
   * S10 (the payoff) rebuilds this picture: read these constants (also exposed at run time as
   * FILM.S1_GEOMETRY and FILM.S1_CROSS_SVG when this file is loaded before yours).
   * Everything is left-aligned at `margin` and right-aligned at 1920 - margin.
   * ===================================================================================== */
  const S1_GEOMETRY = {
    margin: 146,
    /* eyebrow 'YOUR AI AGENT': the shared .eyebrow style (36 px mono, teal, uppercase) */
    eyebrow: { x: 146, y: 150 },
    /* day word: display serif. The word sits in a mask (x, y, w, maskH) and rolls inside it;
     * the text box is inset by -glyphInset so the first stem lands on x. */
    day: { x: 146, y: 190, w: 1200, maskH: 300, fontSize: 232, lineHeight: 290, fontWeight: 600, letterSpacing: '-0.025em', glyphInset: 8 },
    /* tally: n square boxes in a row, right-aligned at `right`; box i of n starts at tallyX(i, n) */
    tally: { right: 1774, y: 326, box: 104, gap: 20, radius: 16, border: 2, cross: 52 },
    /* terminal panel: a header bar with three dots (shared .shelf-head / .shelf-dots), two text lines */
    term: { x: 146, y: 524, w: 1628, h: 290, radius: 18, border: 2, headH: 68,
            lineX: 44, line1Y: 90, line2Y: 174, fontSize: 56, lineHeight: 84 },
    /* sub line under the panel: sans, 64 px */
    sub: { x: 146, y: 852, w: 1500, maskH: 96, fontSize: 64, lineHeight: 90 },
    /* slow push of the whole picture over the scene */
    push: { from: 1.0, to: 1.03, originX: 960, originY: 540 },
  };
  /** Left edge of tally box i (0-based) when n boxes are right-aligned. */
  S1_GEOMETRY.tallyX = (i, n) => S1_GEOMETRY.tally.right - (n - i) * S1_GEOMETRY.tally.box - (n - 1 - i) * S1_GEOMETRY.tally.gap;
  /* The ✗ is drawn, not typed: U+2717 is outside the film fonts and would fall back to a system face.
   * Stroke: var(--warn), width 3.2 in this 24-unit box (class a-x), round caps. */
  const S1_CROSS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="a-x" d="M5 5L19 19M19 5L5 19"/></svg>';
  FILM.S1_GEOMETRY = S1_GEOMETRY;
  FILM.S1_CROSS_SVG = S1_CROSS_SVG;

  /* ---------- constants ---------- */
  const F = 1 / 30;          // one frame
  const E = 1e-4;            // tolerance when comparing film times
  const hook = (fn) => FILM.hooks.push(fn);
  const px = (n) => n + 'px';

  FILM.Backdrop();

  /* ---------- the shelf's real lessons (demo-film.txt, third capture) ---------- */
  const L = {
    a: { id: '40091e', text: 'run the build before the tests' },
    b: { id: '844287', text: 'fresh worktree: install deps first' },
    c: { id: '6a6223', text: 'release by tag: CI publishes it' },
    d: { id: 'd385d1', text: 'tests need Docker running' },
    e: { id: 'd190af', text: 'CI runs macOS too: no GNU-only flags' },
  };
  const rowsOf = (spec) => spec.map(([k, score]) => ({ id: L[k].id, text: L[k].text, score }));
  const S_THREE = [['a', 1], ['b', 1], ['c', 1]];
  const S_FULL = [['a', 1], ['b', 1], ['c', 1], ['d', 1]];
  const S_VOTED = [['a', 3], ['b', 1], ['c', 1], ['d', 0]];

  /* ---------- pure-function-of-time helpers ---------- */

  /** Value that changes in steps: pairs = [[time, value], ...]; the first pair is the initial value. */
  function stepper(pairs) {
    return (t) => {
      let v = pairs[0][1];
      for (let i = 1; i < pairs.length; i++) { if (t >= pairs[i][0] - E) v = pairs[i][1]; else break; }
      return v;
    };
  }
  function htmlAt(el, pairs) {
    const f = stepper(pairs); let last = null;
    hook((t) => { const v = f(t); if (v !== last) { last = v; el.innerHTML = v; } });
  }
  function classAt(el, cls, pairs) { const f = stepper(pairs); hook((t) => { el.classList.toggle(cls, !!f(t)); }); }
  /** Cut an element in and out. mode 'display' removes it from layout; 'hide' keeps its box. */
  function showAt(el, pairs, mode) {
    const f = stepper(pairs);
    hook((t) => {
      const on = !!f(t);
      if (mode === 'hide') el.style.visibility = on ? '' : 'hidden';   // never 'visible': it would leak through a hidden scene
      else el.style.display = on ? '' : 'none';
    });
  }

  /** A number animated in consecutive segments: [start, duration, to, ease, from?].
   *  Each segment starts from the previous segment's end value unless `from` is given (a jump). */
  function track(init, segs) {
    const eases = segs.map((s) => gsap.parseEase(s[3] || 'expo.out'));
    return (t) => {
      let v = init;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (t < s[0] - E) break;
        const from = s[4] != null ? s[4] : v;
        const p = Math.max(0, Math.min(1, (t - s[0]) / s[1]));
        v = from + (s[2] - from) * eases[i](p);
      }
      return v;
    };
  }
  /** Drive an element's transform and/or opacity from tracks: { x, y, s, sx, o }.
   *  snap: true rounds the translation to whole pixels (for a hard edge that must not anti-alias). */
  function drive(el, tr) {
    const hasT = tr.x || tr.y || tr.s || tr.sx;
    hook((t) => {
      if (hasT) {
        let x = tr.x ? tr.x(t) : 0, y = tr.y ? tr.y(t) : 0;
        if (tr.snap) { x = Math.round(x); y = Math.round(y); }
        const s = tr.s ? tr.s(t) : 1, sx = tr.sx ? tr.sx(t) : 1;
        const idle = Math.abs(x) < 0.005 && Math.abs(y) < 0.005 && Math.abs(s - 1) < 1e-4 && Math.abs(sx - 1) < 1e-4;
        el.style.transform = idle ? 'none'
          : 'translate(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px) scale(' + (s * sx).toFixed(4) + ',' + s.toFixed(4) + ')';
      }
      if (tr.o) el.style.opacity = tr.o(t).toFixed(3);
    });
  }

  /** Caret that reads as blinking: on for 0.5 s, off for 0.5 s; solid or hidden inside given windows. */
  function blink(el, opts) {
    opts = opts || {};
    const inAny = (wins, t) => (wins || []).some((w) => t >= w[0] - E && t < w[1] - E);
    hook((t) => {
      let on = Math.floor(t / 0.5 + E) % 2 === 0;
      if (inAny(opts.solid, t)) on = true;
      if (inAny(opts.hide, t)) on = false;
      el.style.opacity = on ? (opts.level || 0.85) : 0;
    });
  }

  /** Terminal command line: segments [{t, text, until, html}]. With `until` the text is typed
   *  from t to until; without it the line prints whole at t. The latest started segment wins. */
  function cmdAt(el, segs) {
    let last = null;
    hook((t) => {
      let s = '';
      for (const g of segs) {
        if (t < g.t - E) break;
        if (g.until) {
          const p = Math.max(0, Math.min(1, (t - g.t) / (g.until - g.t)));
          s = g.text.slice(0, Math.round(p * g.text.length));
        } else s = g.html || g.text;
      }
      if (s !== last) { last = s; el.innerHTML = s; }
    });
  }

  const AMBER = [232, 176, 90], GREEN = [74, 222, 128], RED = [240, 131, 107], TEAL = [70, 191, 166], FG = [231, 235, 242];
  const mix = (a, b, k) => 'rgb(' + a.map((c, i) => Math.round(c + (b[i] - c) * k)).join(',') + ')';
  /** Score chip reaction to votes: an overshooting scale and a colour flash that decays to amber. */
  function chipFx(scoreEl, events) {
    hook((t) => {
      let tf = 'none', col = '';
      for (const ev of events) {
        const u = t - ev.T;
        if (u < -E || u >= 0.6) continue;
        const s = 1 + 0.46 * Math.exp(-u * 8.5) * Math.cos(u * 2 * Math.PI * 3.1);
        const y = ev.sign < 0 ? 7 * Math.exp(-u * 10) : 0;
        tf = 'translateY(' + y.toFixed(2) + 'px) scale(' + s.toFixed(4) + ')';
        col = mix(ev.sign < 0 ? RED : GREEN, AMBER, Math.min(1, Math.max(0, u) / 0.45));
      }
      scoreEl.style.transform = tf;
      scoreEl.style.color = col;
    });
  }
  /** A command line flashes teal on the frame it prints (or re-runs), then settles to white. */
  function printFlash(el, times) {
    hook((t) => {
      let col = '';
      for (const T of times) { const u = t - T; if (u >= -E && u < 7 * F) col = mix(TEAL, FG, Math.max(0, u) / (7 * F)); }
      el.style.color = col;
    });
  }
  /** A sum of short decaying pulses at given times, as a scale factor (1 when idle). */
  function pulseValue(times, amount) {
    return (t) => {
      let s = 1;
      for (const T of times) { const u = t - T; if (u >= -E && u < 0.45) s += amount * Math.exp(-Math.max(0, u) * 11) * (1 - u / 0.45); }
      return s;
    };
  }
  /** Decaying shake of `amp` pixels over `dur` seconds, full amplitude on the frame at T (whole pixels). */
  function shakeValue(events, dur) {
    return (t) => {
      let x = 0;
      for (const ev of events) { const u = t - ev.T; if (u >= -E && u < dur) x = ev.amp * (1 - Math.max(0, u) / dur) * Math.cos(Math.max(0, u) * 2 * Math.PI * 15); }
      return Math.round(x);
    };
  }

  /* ---------- small builders ---------- */
  const world = (root) => h.el('div', 'a-world abs', root);
  /** Row overlays used for feedback: a teal edge and a teal fill, both driven by tracks. */
  function rowOverlays(row) {
    return { edge: h.el('div', 'a-edge', row.el), fill: h.el('div', 'a-fill', row.el) };
  }
  /** Who runs the command: hide the strip's `$` prompt and hang a label chip in its place. */
  function who(strip, pairs) {
    strip.line.querySelector('.strip-prompt').style.display = 'none';
    strip.line.style.position = 'relative';
    const chip = h.el('span', 'a-who', strip.line);
    htmlAt(chip, pairs);
    return chip;
  }
  const caretOf = (strip) => strip.line.querySelector('.strip-caret');
  const SUB_LIFT = '-10px';                  // the sub line sits 10 px closer to its headline, for air above the shelf
  const STRIP_Y = G.y + G.h + 26;            // top of the strip's first line (FILM.Strip)
  const STRIP_LH = 44 * 1.45;                // the strip's line height (film.css)
  const CH = 44 * 0.6;                       // one character of 44 px terminal type
  const ROW_TEXT_X = G.x + 2 + 14 + 2 + 26 + 212 + 158;        // x of a row's lesson text
  const SLOT_TOP = (i) => G.y + 2 + G.slotY(i);                // stage y of slot i
  const SLOT_PITCH = G.rowH + G.gap;
  // A row-shaped card just outside the shelf, under slot 4, as a y offset from slot 4.
  const TOUCH = G.h - 2 - G.slotY(3) + 2;    // pressed against the shelf's bottom edge (2 px of air)
  const REST = TOUCH + 8;                    // resting: it sits on the strip's command line

  /* =====================================================================================
   * S1 · Hook · 0.0 – 4.0
   * ===================================================================================== */
  FILM.scene('s1', 0, 4, function (root) {
    const g = S1_GEOMETRY;
    const FAILS = [{ T: 0.9, amp: 12, flash: 0.20 }, { T: 2.8, amp: 18, flash: 0.30 }, { T: 3.5, amp: 26, flash: 0.45 }];
    const ROLLS = [2.1, 3.3];
    const INHALE = 3.8, BARE = 4 - 2 * F;    // the last two frames before 4.0 are bare background

    const W = world(root);
    W.style.transformOrigin = px(g.push.originX) + ' ' + px(g.push.originY);
    showAt(W, [[0, true], [BARE, false]]);
    // a slow push for the whole scene, then the inhale: draw back and dim ahead of the reveal
    drive(W, {
      s: track(g.push.from, [[0, INHALE, g.push.to, 'none'], [INHALE, BARE - INHALE, 0.96, 'power2.in']]),
      o: track(1, [[INHALE, BARE - INHALE, 0.35, 'power2.in']]),
    });

    const eyebrow = h.el('div', 'eyebrow a-eyebrow1 abs', W); eyebrow.textContent = 'YOUR AI AGENT';
    Object.assign(eyebrow.style, { left: px(g.eyebrow.x), top: px(g.eyebrow.y) });

    const dayMask = h.el('div', 'a-day-mask abs', W);
    Object.assign(dayMask.style, { left: px(g.day.x - g.day.glyphInset), top: px(g.day.y), width: px(g.day.w), height: px(g.day.maskH) });
    const days = ['Monday', 'Tuesday', 'Wednesday'].map((d) => {
      const e = h.el('div', 'a-day', dayMask); e.textContent = d;
      Object.assign(e.style, { left: px(g.day.glyphInset), fontSize: px(g.day.fontSize), lineHeight: px(g.day.lineHeight),
        fontWeight: g.day.fontWeight, letterSpacing: g.day.letterSpacing });
      return e;
    });
    const H = g.day.maskH, rollDur = [10 * F, 6 * F];
    drive(days[0], { y: track(0, [[ROLLS[0], rollDur[0], -H, 'expo.out']]) });
    drive(days[1], { y: track(H, [[ROLLS[0], rollDur[0], 0, 'expo.out'], [ROLLS[1], rollDur[1], -H, 'expo.out']]) });
    drive(days[2], { y: track(H, [[ROLLS[1], rollDur[1], 0, 'expo.out']]) });

    const tally = h.el('div', 'a-tally abs', W);
    Object.assign(tally.style, { left: '0px', top: px(g.tally.y) });
    FAILS.forEach((f, i) => {
      const slot = h.el('div', 'a-slot', tally);
      Object.assign(slot.style, { left: px(g.tallyX(i, FAILS.length)), width: px(g.tally.box), height: px(g.tally.box), borderRadius: px(g.tally.radius), borderWidth: px(g.tally.border) });
      const x = h.el('div', '', slot, S1_CROSS_SVG);
      Object.assign(x.firstChild.style, { width: px(g.tally.cross), height: px(g.tally.cross) });
      classAt(slot, 'a-on', [[0, false], [f.T, true]]);
      showAt(x, [[0, false], [f.T, true]], 'hide');
      drive(x, { s: track(1, [[f.T, 8 * F, 1, 'expo.out', 1.9 + 0.3 * i]]) });
    });

    const term = h.el('div', 'a-term abs', W);
    Object.assign(term.style, { left: px(g.term.x), top: px(g.term.y), width: px(g.term.w), height: px(g.term.h), borderRadius: px(g.term.radius), borderWidth: px(g.term.border) });
    const flash = h.el('div', 'a-term-flash', term); flash.style.borderRadius = px(g.term.radius - g.term.border);
    const head = h.el('div', 'shelf-head', term);
    h.el('span', 'shelf-dots', head, '<i></i><i></i><i></i>');
    const lineStyle = (top) => ({ left: px(g.term.lineX), top: px(top), fontSize: px(g.term.fontSize), lineHeight: px(g.term.lineHeight) });
    const l1 = h.el('div', 'a-tline', term); Object.assign(l1.style, lineStyle(g.term.line1Y));
    h.el('span', 'a-prompt', l1, '$ ');
    const cmd = h.el('span', '', l1); cmd.textContent = 'npm test';
    const caret = h.el('span', 'a-tcaret', l1);
    const l2 = h.el('div', 'a-tline a-l2', term, '<span class="a-xch">' + S1_CROSS_SVG + '</span> tests failed: forgot the build');
    Object.assign(l2.style, lineStyle(g.term.line2Y));
    const failEdge = h.el('div', 'a-term-fail', term); failEdge.style.borderRadius = px(g.term.radius);

    // replayed faster each day: typed in 0.2 s on Tuesday, in 0.1 s on Wednesday
    cmdAt(cmd, [
      { t: -1, text: 'npm test' },
      { t: ROLLS[0], text: '' }, { t: 2.3, text: 'npm test', until: 2.5 },
      { t: ROLLS[1], text: '' }, { t: 3.33, text: 'npm test', until: 3.43 },
    ]);
    const failed = [[0, false], [FAILS[0].T, true], [ROLLS[0], false], [FAILS[1].T, true], [ROLLS[1], false], [FAILS[2].T, true]];
    showAt(l2, failed, 'hide');
    showAt(failEdge, failed);   // the red-pink border is an overlay: the panel itself is never repainted
    blink(caret, { solid: [[2.3, 2.8], [3.3, 3.5]], hide: [[FAILS[0].T, ROLLS[0]], [FAILS[1].T, ROLLS[1]], [FAILS[2].T, 99]] });
    // the three failures escalate: a harder shake and a stronger red-pink flash each time, both over 6 frames
    const shake = shakeValue(FAILS, 6 * F);
    hook((t) => { const x = shake(t); term.style.transform = x === 0 ? 'none' : 'translateX(' + x + 'px)'; });
    drive(flash, { o: track(0, FAILS.map((f) => [f.T, 6 * F, 0, 'power1.out', f.flash])) });

    const subMask = h.el('div', 'a-sub-mask abs', W);
    Object.assign(subMask.style, { left: px(g.sub.x), top: px(g.sub.y), width: px(g.sub.w), height: px(g.sub.maskH) });
    const sub = h.el('div', 'a-sub', subMask, 'Same trap. <span>Every session.</span>');
    Object.assign(sub.style, { fontSize: px(g.sub.fontSize), lineHeight: px(g.sub.lineHeight) });
    drive(sub, { y: track(g.sub.maskH + 4, [[2.8, 8 * F, 0, 'expo.out']]) });
  });

  /* =====================================================================================
   * S2 · Reveal · 4.0 – 7.0 (first big cut)
   * ===================================================================================== */
  FILM.scene('s2', 4, 7, function (root) {
    const EXIT = 7 - 4 * F;
    /* the shelf, drawn in at its fixed geometry: outline, then header bar, title and gauge */
    const shelf = FILM.Shelf(root, { rows: rowsOf(S_THREE), count: 0 });
    drive(shelf.root, { o: track(0, [[5.5, 9 * F, 1, 'power2.out']]) });
    const svg = h.el('div', 'a-draw abs', root,
      '<svg width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden="true"><rect x="' + (G.x + 1) + '" y="' + (G.y + 1) + '" width="' + (G.w - 2) + '" height="' + (G.h - 2) + '" rx="17" pathLength="1"/></svg>');
    const rect = svg.querySelector('rect');
    const draw = track(1, [[5.2, 12 * F, 0, 'expo.inOut']]);
    hook((t) => { rect.style.strokeDashoffset = draw(t).toFixed(4); });
    showAt(svg, [[0, false], [5.2, true]]);
    drive(svg, { o: track(1, [[5.65, 7 * F, 0, 'power2.in']]) });

    // S-three lands one row per beat; the gauge counts with it
    const LANDS = [5.9, 6.2, 6.5];
    shelf.rows.forEach((r, i) => {
      const T = LANDS[i], ov = rowOverlays(r);
      showAt(r.el, [[0, false], [T, true]], 'hide');
      drive(r.el, { y: track(0, [[T, 6 * F, 0, 'expo.out', 16]]) });
      drive(ov.edge, { o: track(1, [[T, 12 * F, 0, 'power2.out']]) });
      drive(ov.fill, { o: track(0, [[T, 10 * F, 0, 'power2.out', 0.34]]) });
    });
    htmlAt(shelf.gauge, [[0, '0 / 4'], [LANDS[0], '1 / 4'], [LANDS[1], '2 / 4'], [LANDS[2], '3 / 4']]);
    const gPulse = pulseValue(LANDS, 0.16);
    shelf.gauge.style.transformOrigin = '100% 50%';
    hook((t) => { const s = gPulse(t); shelf.gauge.style.transform = Math.abs(s - 1) < 1e-4 ? 'none' : 'scale(' + s.toFixed(4) + ')'; });

    /* 4.0 the cut: a violet frame and the wordmark at full size, centred, already there */
    const violet = h.el('div', 'a-violet a-full abs', root);
    drive(violet, { o: track(0, [[4.0, 5 * F, 0, 'power1.out', 0.85]]) });

    // the wordmark: built at its lockup (150 px, left edge x = 260) and scaled up to the hero size
    const WM = { x: 252, y: 66, w: 887.5, h: 180, hero: 250 / 150, heroCx: 960, heroCy: 514 };
    const wm = h.el('div', 'a-wm abs', root); wm.textContent = 'agent-notebook';
    Object.assign(wm.style, { left: px(WM.x), top: px(WM.y) });
    const hit = track(1.10, [[4.0, 8 * F, 1.0, 'expo.out']]);     // 1.10 -> 1.00 over 8 frames
    const travel = track(0, [[4.5, 0.5, 1, 'expo.inOut']]);       // 4.5–5.0 to the lockup
    const leave = track(0, [[EXIT, 4 * F, 1, 'power3.in']]);
    hook((t) => {
      const p = travel(t), q = leave(t);
      const S = WM.hero * hit(t) * (1 - p) + p;
      const cx = WM.heroCx + (WM.x + WM.w / 2 - WM.heroCx) * p, cy = WM.heroCy + (WM.y + WM.h / 2 - WM.heroCy) * p - 30 * q;
      const tx = cx - WM.x - (WM.w * S) / 2, ty = cy - WM.y - (WM.h * S) / 2;
      wm.style.transform = (p >= 1 && q <= 0) ? 'none' : 'translate(' + tx.toFixed(2) + 'px,' + ty.toFixed(2) + 'px) scale(' + S.toFixed(4) + ')';
      wm.style.opacity = (1 - q).toFixed(3);
    });

    const subMask = h.el('div', 'a-wmsub-mask abs', root);
    const sub = h.el('div', 'a-wmsub', subMask); sub.textContent = 'A page of lessons for your AI agent.';
    drive(sub, { y: track(84, [[5.0, 10 * F, 0, 'expo.out'], [EXIT, 4 * F, -84, 'power3.in']]) });
  });

  /* =====================================================================================
   * S3 · One lesson = one line · 7.0 – 10.5
   * ===================================================================================== */
  FILM.scene('s3', 7, 10.5, function (root) {
    const ENTER = 8.8, LAND = 9.2;
    const strip = FILM.Strip(root);
    const shelf = FILM.Shelf(root, { rows: rowsOf(S_THREE) });

    const hl = FILM.Headline(root, { eyebrow: 'WHAT IT IS', l1: 'One text file.', l2: 'One lesson = one line.' });
    hl.l2.parentNode.style.marginTop = SUB_LIFT;
    drive(hl.eyebrow, { o: track(0, [[7, 8 * F, 1, 'power2.out']]) });
    drive(hl.l1, { y: track(130, [[7, 11 * F, 0, 'expo.out']]) });
    drive(hl.l2, { y: track(90, [[7.1, 11 * F, 0, 'expo.out']]) });

    htmlAt(shelf.gauge, [[0, '3 / 4'], [LAND, '4 / 4 full']]);
    classAt(shelf.gauge, 'full', [[0, false], [LAND, true]]);
    const gPulse = pulseValue([LAND], 0.22);
    shelf.gauge.style.transformOrigin = '100% 50%';
    hook((t) => { const s = gPulse(t); shelf.gauge.style.transform = Math.abs(s - 1) < 1e-4 ? 'none' : 'scale(' + s.toFixed(4) + ')'; });

    /* strip: you type the command; it stays on screen as the lesson lifts out of it */
    who(strip, [[0, 'you']]);
    drive(strip.root, { o: track(0, [[7.15, 8 * F, 1, 'power2.out']]) });
    const PRE = 'nb add build "', LESSON = L.d.text;
    cmdAt(strip.cmd, [
      { t: 7.6, text: PRE + LESSON + '"', until: 8.7 },
      { t: ENTER, html: PRE + '<span class="a-src">' + LESSON + '</span>"' },
    ]);
    blink(caretOf(strip), { solid: [[7.6, ENTER]], hide: [[ENTER, 99]] });
    htmlAt(strip.out1, [[0, ''], [8.9, 'added — 4 lines']]);

    /* Enter: the lesson's own words rise from the command into slot 4, where its row forms around them */
    const row = shelf.addRow({ id: L.d.id, text: L.d.text, score: 1 }, 3);
    const ov = rowOverlays(row);
    drive(row.el, { o: track(0, [[ENTER + 2 * F, 8 * F, 1, 'power2.out']]) });
    showAt(row.textEl, [[0, false], [LAND, true]], 'hide');
    drive(ov.edge, { o: track(1, [[LAND, 14 * F, 0, 'power2.out']]) });
    drive(ov.fill, { o: track(0, [[LAND, 12 * F, 0, 'power2.out', 0.34]]) });
    const lift = h.el('div', 'a-lift abs', root); lift.textContent = LESSON;
    const PLATE = 14;                                  // the plate's side padding + border
    const x0 = G.x + PRE.length * CH - PLATE, y0 = STRIP_Y;
    const x1 = ROW_TEXT_X - PLATE, y1 = SLOT_TOP(3) + G.rowH / 2 - STRIP_LH / 2;
    Object.assign(lift.style, { left: px(x0), top: px(y0) });
    showAt(lift, [[0, false], [ENTER, true], [LAND, false]]);
    drive(lift, { x: track(0, [[ENTER, LAND - ENTER, x1 - x0, 'power2.inOut']]), y: track(0, [[ENTER, LAND - ENTER, y1 - y0, 'power2.inOut']]) });
  });

  /* =====================================================================================
   * S4 · Shown at the start, voted at the end · 10.5 – 17.0
   * ===================================================================================== */
  FILM.scene('s4', 10.5, 17, function (root) {
    const SWAP = 13.7, UNLIT = 13.5;
    const cam = world(root);                              // everything moves with the camera, headline included
    cam.style.transformOrigin = '120px 300px';
    const strip = FILM.Strip(cam);
    const shelf = FILM.Shelf(cam, { rows: rowsOf(S_FULL) });

    const hl = FILM.Headline(cam, { eyebrow: 'TASK START · YOUR HARNESS RUNS', l1: 'Shown to the agent.' });
    const eb2 = h.el('div', 'eyebrow a-eyebrow2', hl.root); eb2.textContent = 'TASK END · THE AGENT VOTES';
    const m1 = hl.l1.parentNode; m1.style.position = 'relative';
    const l1b = h.el('div', 'hl-line a-hl2', m1); l1b.textContent = 'Voted on what helped.';
    drive(hl.eyebrow, { o: track(0, [[10.5, 8 * F, 1, 'power2.out'], [SWAP - 5 * F, 4 * F, 0, 'power2.in']]) });
    drive(eb2, { o: track(0, [[SWAP, 7 * F, 1, 'power2.out']]) });
    drive(hl.l1, { y: track(130, [[10.5, 11 * F, 0, 'expo.out'], [SWAP - 6 * F, 6 * F, -130, 'power3.in']]) });
    drive(l1b, { y: track(130, [[SWAP, 11 * F, 0, 'expo.out']]) });

    /* strip: at task start the hook lists and the agent opens; at task end the agent votes */
    const VOTE = (id, v) => 'nb vote build ' + id + ' <span class="' + (v > 0 ? 'a-pos' : 'a-neg') + '">' + (v > 0 ? '+1' : '-1') + '</span>';
    const V = [{ T: 14.3, k: 'a', to: 2, sign: 1 }, { T: 14.9, k: 'a', to: 3, sign: 1 }, { T: 15.7, k: 'd', to: 0, sign: -1 }];
    who(strip, [[0, 'hook'], [11.7, 'agent']]);   // the hook lists the notebooks; the agent opens the one that fits
    cmdAt(strip.cmd, [
      { t: 11.0, text: 'nb list' },
      { t: 11.7, text: 'nb show build' },
      { t: SWAP, text: '' },
      { t: V[0].T, html: VOTE(L.a.id, 1) },
      { t: V[2].T, html: VOTE(L.d.id, -1) },
    ]);
    blink(caretOf(strip), { hide: [[11.0, SWAP], [V[0].T, 99]] });
    printFlash(strip.cmd, [11.0, 11.7].concat(V.map((v) => v.T)));

    // 12.0 / 12.2 / 12.4 / 12.6: each row is shown — a teal sweep, then the row stays lit until the task ends
    shelf.rows.forEach((r, i) => {
      const T = 12.0 + i * 0.2;
      const sweep = h.el('div', 'a-sweep', r.el);
      drive(sweep, { sx: track(0, [[T, 9 * F, 1, 'expo.out']]), o: track(1, [[T + 6 * F, 12 * F, 0.3, 'power2.out'], [UNLIT - 5 * F, 6 * F, 0, 'power2.in']]) });
      classAt(r.el, 'hot', [[0, false], [T, true], [UNLIT, false]]);
    });

    // a modest push for the votes (the whole picture, anchored at the left margin), back by 16.9
    drive(cam, { s: track(1, [[SWAP, 0.5, 1.08, 'expo.inOut'], [16.4, 0.5, 1, 'expo.inOut']]) });

    // votes: the score changes on the frame the command prints; the command's +1 / -1 streaks into the chip
    // (a thin line, so nothing legible ever crosses the rows' text)
    V.forEach((v) => {
      const row = shelf.row(L[v.k].id);
      const x0 = G.x + 22 * CH, y0 = STRIP_Y + STRIP_LH / 2, x1 = ROW_TEXT_X - 158 + 53, y1 = SLOT_TOP(row.slot) + G.rowH / 2;
      const len = Math.hypot(x1 - x0, y1 - y0), ang = Math.atan2(y1 - y0, x1 - x0);
      const arm = h.el('div', 'a-streak-arm abs', cam);
      Object.assign(arm.style, { left: px(x0), top: px(y0), width: px(len), transform: 'rotate(' + ang.toFixed(5) + 'rad)' });
      const line = h.el('div', 'a-streak ' + (v.sign > 0 ? 'a-streak-pos' : 'a-streak-neg'), arm);
      showAt(arm, [[0, false], [v.T, true], [v.T + 4 * F, false]]);
      drive(line, { sx: track(1, [[v.T, 2 * F, 1, 'power2.out', 0.55]]), o: track(0, [[v.T, 4 * F, 0, 'power2.in', 0.9]]) });
    });
    ['a', 'd'].forEach((k) => {
      const row = shelf.row(L[k].id), mine = V.filter((v) => v.k === k);
      htmlAt(row.scoreEl, [[0, FILM.fmtScore(1)]].concat(mine.map((v) => [v.T, FILM.fmtScore(v.to)])));
      chipFx(row.scoreEl, mine);
    });
    classAt(shelf.row(L.d.id).el, 'out', [[0, false], [V[2].T, true]]);
  });

  /* =====================================================================================
   * S5 · The cap · 17.0 – 23.5 (second big cut at 18.4)
   * ===================================================================================== */
  FILM.scene('s5', 17, 23.5, function (root) {
    const HIT = 18.4, NUDGES = [18.9, 19.4, 19.9], PULL = 20.4 - 4 * F, EVICT = 20.4, GONE = 20.6, RISE = 20.7, LAND = 21.1, AGE = 21.6;
    const W = world(root);
    W.style.transformOrigin = '960px ' + px(G.y + G.h);   // the punch grows from the shelf's bottom edge, where the card hits
    /* the world's own motion: the 1.12 punch with a vertical shake at 18.4, a 1.05 punch at 20.4 */
    const expoOut = gsap.parseEase('expo.out');
    const SHAKE = [-24, 12, -6, 3, 0];   // one value every second frame
    hook((t) => {
      let s = 1, y = 0;
      let u = t - HIT;
      if (u >= -E && u < 10 * F) {
        s = 1 + 0.12 * (1 - expoOut(Math.max(0, u) / (10 * F)));
        const f = Math.max(0, u) / (2 * F), i = Math.min(SHAKE.length - 2, Math.floor(f)), k = Math.min(1, f - i);
        y = Math.round(SHAKE[i] + (SHAKE[i + 1] - SHAKE[i]) * (0.5 - 0.5 * Math.cos(Math.PI * k)));
      }
      u = t - EVICT;
      if (u >= -E && u < 8 * F) s = 1 + 0.05 * (1 - expoOut(Math.max(0, u) / (8 * F)));
      W.style.transform = (s === 1 && y === 0) ? 'none' : 'translate(0px,' + y + 'px) scale(' + s.toFixed(4) + ')';
    });
    const white = h.el('div', 'a-white a-full abs', root);
    drive(white, { o: track(0, [[HIT, 3 * F, 0, 'none', 0.30]]) });

    const strip = FILM.Strip(W);
    const shelf = FILM.Shelf(W, { rows: rowsOf(S_VOTED) });
    const rowB = shelf.row(L.b.id), rowC = shelf.row(L.c.id), rowD = shelf.row(L.d.id);
    rowD.el.classList.add('out');                         // S-voted: the down-voted row is already marked

    /* headline (inside the world: it takes the punch with everything else) */
    const hl = FILM.Headline(W, { eyebrow: ' ', l1: 'The file is capped.', l2: 'Lowest score <span class="a-warn">out.</span>' });
    hl.l2.parentNode.style.marginTop = SUB_LIFT;
    const m1 = hl.l1.parentNode; m1.style.position = 'relative';
    const l1b = h.el('div', 'hl-line a-hl2', m1, 'New lesson <em>in.</em>');
    drive(hl.l1, { y: track(130, [[17, 11 * F, 0, 'expo.out']]) });
    showAt(hl.l1, [[0, true], [HIT, false]], 'hide');     // a hard cut on the hit: one headline out, the next in
    showAt(l1b, [[0, false], [HIT, true]], 'hide');
    drive(hl.l2, { y: track(90, [[EVICT, 10 * F, 0, 'expo.out']]) });

    /* the gauge insists: full. Beats before the hit, 1 -> 1.7 -> 1 on it, a twitch with every nudge */
    const beat = pulseValue([17.0, 17.5, 18.0].concat(NUDGES), 0.17);
    const slam = track(1, [[HIT, 2 * F, 1.7, 'power2.out', 1.35], [HIT + 2 * F, 10 * F, 1, 'power2.inOut']]);
    shelf.gauge.style.transformOrigin = '100% 50%';
    hook((t) => { const s = beat(t) * slam(t); shelf.gauge.style.transform = Math.abs(s - 1) < 1e-4 ? 'none' : 'scale(' + s.toFixed(4) + ')'; });
    const note = h.el('div', 'a-note abs', W, '<b>4</b> lines in this demo.<br><b>50</b> by default.');
    drive(note, { o: track(0, [[17.0, 8 * F, 1, 'power2.out']]) });

    /* strip: the agent types the command; later (one line up, as a terminal scrolls) the real output */
    who(strip, [[0, 'agent']]);
    cmdAt(strip.cmd, [{ t: 17.1, text: 'nb add build "' + L.e.text + '"', until: 18.1 }]);
    blink(caretOf(strip), { solid: [[17.1, HIT]], hide: [[HIT, 99]] });
    showAt(strip.line, [[0, true], [HIT, false]], 'hide');   // the card takes the command's place
    hook((t) => { strip.root.style.transform = t >= AGE - E ? 'translateY(' + (-STRIP_LH).toFixed(1) + 'px)' : 'none'; });
    htmlAt(strip.out1, [[0, ''], [AGE, 'added — 4 lines']]);
    htmlAt(strip.out2, [[0, ''], [AGE, '(<em>evicted</em> lowest-scored: <span class="a-score">[+0]</span> tests need Docker running)']]);

    /* 18.4 the newcomer: a row-shaped card shoots up 110 px in 4 frames and presses against the full shelf */
    const rowE = shelf.addRow({ id: L.e.id, text: L.e.text, score: 1 }, 3);
    const ov = rowOverlays(rowE);
    showAt(rowE.el, [[0, false], [HIT, true]], 'hide');
    const nudges = [];
    NUDGES.forEach((T) => { nudges.push([T - 2 * F, 2 * F, TOUCH, 'power2.in'], [T, 6 * F, REST, 'power2.out']); });
    const yE = track(TOUCH + 110, [[HIT, 4 * F, TOUCH, 'power4.out'], [HIT + 5 * F, 6 * F, REST, 'power2.inOut']]
      .concat(nudges)
      .concat([[RISE, LAND - RISE, 0, 'power2.inOut'],            // 20.7–21.1: into the freed slot
               [AGE, 12 * F, -SLOT_PITCH, 'power3.inOut']]));     // 21.6: steps up to slot 3
    const dim = track(1, [[AGE, 3 * F, 0.18, 'power2.out'], [AGE + 9 * F, 6 * F, 1, 'power2.in']]);   // nearly gone while the aged row crosses them
    drive(rowE.el, { y: yE, o: dim });
    drive(ov.edge, { o: track(1, [[LAND, 14 * F, 0, 'power2.out']]) });
    drive(ov.fill, { o: track(0, [[LAND, 12 * F, 0, 'power2.out', 0.34]]) });

    /* 20.4 the lowest score: it flinches back 32 px, filling red-pink, then leaves to the right, whole */
    const fillD = h.el('div', 'a-fill a-fill-warn', rowD.el);
    drive(fillD, { o: track(0, [[PULL, 4 * F, 0.3, 'power2.out']]) });
    rowD.el.style.transformOrigin = '0% 50%';
    drive(rowD.el, {
      x: track(0, [[PULL, 4 * F, -32, 'power2.out'], [EVICT, GONE - EVICT, 1700, 'power3.in']]),
      sx: track(1, [[EVICT, GONE - EVICT, 1.12, 'power3.in']]),
    });
    showAt(rowD.el, [[0, true], [GONE, false]]);

    /* 21.6 aging: the line unused the longest loses a point and drops to the bottom; it travels above
       the two rows that step up beneath it, which fade almost out while it crosses them, so no legible
       text is ever cut by an edge */
    htmlAt(rowB.scoreEl, [[0, FILM.fmtScore(1)], [AGE, FILM.fmtScore(0)]]);
    chipFx(rowB.scoreEl, [{ T: AGE, sign: -1 }]);
    rowB.el.style.zIndex = 3;
    drive(h.el('div', 'a-lifted', rowB.el), { o: track(0, [[AGE, 4 * F, 1, 'power2.out'], [AGE + 10 * F, 5 * F, 0, 'power2.in']]) });
    drive(rowB.el, {
      y: track(0, [[AGE, 14 * F, 2 * SLOT_PITCH, 'power3.inOut']]),
      s: track(1, [[AGE, 5 * F, 1.03, 'power2.out'], [AGE + 9 * F, 6 * F, 1, 'power2.inOut']]),
    });
    drive(rowC.el, { y: track(0, [[AGE, 12 * F, -SLOT_PITCH, 'power3.inOut']]), o: dim });
    // the caption is a sans tab hanging just under the shelf's edge, below slot 4, where the aged row lands
    const cap = h.el('div', 'a-agecap abs', W, 'unused the longest: <span class="a-neg">−1</span>');
    cap.style.top = px(G.y + G.h + 6);
    drive(cap, { o: track(0, [[AGE, 5 * F, 1, 'power2.out', 0.5]]), y: track(0, [[AGE, 8 * F, 0, 'expo.out', 14]]) });
  });
})();
