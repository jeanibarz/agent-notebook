/* Scenes S6, S7, S8, S10, S9 (23.5-49.0 s), builder B, storyboard v2.
 *
 * Shape of this file: each scene is a `build*` function (DOM at fixed stage pixels, initial states
 * set once) plus an `anim*` function (tweens only). Three transitions need the previous scene's
 * last frame under them (the wipe to paper, the wipe back, the payoff clearing for the end card);
 * the next scene builds a second copy with the same build function and freezes it at the end of
 * the same anim function on a paused timeline, so the copy cannot drift from the original.
 *
 * Seek-safety rules followed throughout: every tween is a fromTo with immediateRender:false and
 * lazy:false; one writer per (element, property); things computed from t live in FILM.hooks.
 * Nothing in these scenes is promoted to its own compositor layer (force3D:false here, will-change
 * reset in scenes-b.css): a cached layer keeps the sub-pixel phase it was first painted at, which
 * would make a frame's anti-aliasing depend on the frames rendered before it.
 *
 * Event times: a cut is visible on the frame at its stated time T. An eased entrance starts one
 * frame before T, so the frame at T already shows it arriving (same convention as scenes-a.js). */
(function () {
  const h = FILM.h, G = FILM.SHELF;
  const F = 1 / 30;
  const FG = '#e7ebf2', MUTED = '#8c97a8', LINE = '#2a3340', PANEL = '#1d2531', TEAL = '#46bfa6';
  const BELOW = G.y + G.h + 26;            // top of the strip position under the shelf (906)

  /* S-final, third capture (`nb show build`) */
  const ROWS = [
    { id: '40091e', score: 3, text: 'run the build before the tests' },
    { id: '6a6223', score: 1, text: 'release by tag: CI publishes it' },
    { id: 'd190af', score: 1, text: 'CI runs macOS too: no GNU-only flags' },
    { id: '844287', score: 0, text: 'fresh worktree: install deps first' },
  ];

  /* ---------- tween helpers ---------- */
  const TRANSFORMS = { x: 1, y: 1, xPercent: 1, yPercent: 1, scale: 1, scaleX: 1, scaleY: 1 };
  const seen = new WeakMap();     // target -> properties that already have a build-time value
  /** fromTo with explicit start values; safe for repeated tweens of one property and for seeking.
   *  The first tween of a property also writes its start value at build time, so the state before
   *  the tween is the same whether the playhead has never reached it or has been rewound past it
   *  (GSAP reverts a rewound tween to what it found; "nothing" and "identity" must not differ). */
  function ft(tl, target, from, to, at, dur, ease, extra) {
    const vars = { duration: dur, ease: ease || 'expo.out', immediateRender: false, lazy: false };
    (Array.isArray(target) ? target : [target]).forEach((el) => {
      if (!seen.has(el)) seen.set(el, {});
      const known = seen.get(el), first = {};
      for (const k in from) if (!known[k]) { known[k] = 1; first[k] = from[k]; }
      if (Object.keys(first).length) gsap.set(el, first);
    });
    for (const k in to) if (TRANSFORMS[k]) vars.force3D = false;
    return tl.fromTo(target, from, Object.assign(vars, to, extra || {}), Math.max(0, at));
  }
  /** A cut: the property flips just before `at`, so the frame rendered at `at` already shows it. */
  function cut(tl, target, from, to, at) { return ft(tl, target, from, to, at - 0.006, 0.004, 'none'); }
  /** Eased entrances start one frame early: the frame at `at` shows them arriving. */
  const rollIn = (tl, el, at, dur) => ft(tl, el, { yPercent: 110 }, { yPercent: 0 }, at - F, dur || 0.36);
  const rise = (tl, el, at, dur, dy) => ft(tl, el, { opacity: 0, y: dy == null ? 18 : dy }, { opacity: 1, y: 0 }, at - F, dur || 0.33);
  const fade = (tl, el, at, dur) => ft(tl, el, { opacity: 0 }, { opacity: 1 }, at - F, dur || 0.3, 'power2.out');
  /** Run an anim function to its end on a paused timeline: a frozen copy of a scene's last frame. */
  function freeze(anim, e) { const g = gsap.timeline({ paused: true }); anim(g, e); g.progress(1); return g; }
  const px = (n) => n + 'px';
  function place(el, x, y, w, hh) {
    el.style.left = px(x); el.style.top = px(y);
    if (w != null) el.style.width = px(w);
    if (hh != null) el.style.height = px(hh);
    return el;
  }
  const svg = (cls, parent, inner) => h.el('div', cls, parent,
    '<svg class="b-svg" width="1920" height="1080" viewBox="0 0 1920 1080">' + inner + '</svg>');
  const lerp = (p, a, b) => a + (b - a) * p;

  /* =====================================================================================
   * S6 · Shown, not searched · 23.5 - 31.0   (third big cut at 23.8)
   * ===================================================================================== */
  const S6 = 23.5;
  const ROW_Y = G.y + 2 + G.slotY(0) + G.rowH / 2;   // centre line of row 40091e (502)
  const ROW_X = G.x + 2 + 14;                        // its left edge (276)
  const LEAD = { x0: 244, x1: 208, y0: 312 };        // elbow leader in the left gutter
  const LEAD_LEN = (LEAD.x0 - LEAD.x1) + (ROW_Y - LEAD.y0) + (ROW_X - 6 - LEAD.x1);
  /* The big cut: the headline lockup is scaled about the ink centre of its line (693, 216 at
   * lockup size) and moved so that point sits on the stage centre. */
  const BIG = { ox: 693, oy: 216, scale: 1.9, punch: 2.0 };
  BIG.x = FILM.W / 2 - BIG.ox; BIG.y = FILM.H / 2 - BIG.oy;

  function buildS6(root) {
    const e = {};
    e.shelfLayer = h.el('div', 'b-layer', root);
    e.shelf = FILM.Shelf(e.shelfLayer, { rows: ROWS });
    e.flash = h.el('div', 'b-flash', root); e.flash.style.background = TEAL;
    e.lock = h.el('div', 'b-layer', root);
    gsap.set(e.lock, { transformOrigin: BIG.ox + 'px ' + BIG.oy + 'px' });
    e.hl = FILM.Headline(e.lock, { l1: '<em>Shown</em>, not <span class="b-strike">searched<i></i></span>.' });
    e.word = e.hl.l1.querySelector('.b-strike');
    e.strike = e.word.querySelector('i');

    // caption for row 40091e: in the sub-line slot, elbow leader down the gutter to the row
    e.note = place(h.el('div', 'b-note', root), G.x, 286); e.note.textContent = 'the one it would never have searched for';
    e.leader = svg('b-leader b-layer', root,
      '<path d="M' + LEAD.x0 + ',' + LEAD.y0 + ' H' + LEAD.x1 + ' V' + ROW_Y + ' H' + (ROW_X - 6) + '"/>');
    e.leadPath = e.leader.querySelector('path');
    e.leadPath.style.strokeDasharray = LEAD_LEN + ' ' + LEAD_LEN;
    e.leadDot = h.el('div', 'b-leader-dot', root); place(e.leadDot, ROW_X, ROW_Y);

    // the search field nobody types in
    e.search = h.el('div', 'b-search', root,
      '<svg width="44" height="44" viewBox="0 0 40 40"><circle cx="17" cy="17" r="11"/><path d="M26 26 L35 35"/></svg>' +
      '<i class="b-caret"></i><span class="b-ph">search…</span>');
    place(e.search, G.x, BELOW - 2, 430);
    e.caret = e.search.querySelector('.b-caret');
    e.searchLabel = h.el('div', 'b-search-label', root);
    e.searchLabel.textContent = 'A search finds only what you think to ask.';
    place(e.searchLabel, G.x + 430 + 32, BELOW - 2);

    // three plain tags, same position
    const tags = place(h.el('div', 'b-tags', root), G.x, BELOW);
    e.tags = ['embeddings', 'vector DB', 'network call'].map((w) => h.el('div', 'b-tag', tags, '<span>no</span> ' + w));

    gsap.set(e.word, { color: FG });
    gsap.set(e.leadPath, { strokeDashoffset: LEAD_LEN });
    return e;
  }

  function animS6(tl, e) {
    const a = (t) => t - S6;
    // 23.5-23.7 the shelf steps back
    ft(tl, e.shelfLayer, { opacity: 1 }, { opacity: 0.18 }, a(23.5), 0.2, 'power2.in');
    // 23.8 hard cut: the headline, centred, very large; a short punch and a flash frame under the type
    cut(tl, e.lock, { opacity: 0 }, { opacity: 1 }, a(23.8));
    ft(tl, e.lock, { scale: BIG.punch, x: BIG.x, y: BIG.y }, { scale: BIG.scale, x: BIG.x, y: BIG.y }, a(23.8) - 0.006, 8 * F);
    cut(tl, e.flash, { opacity: 0 }, { opacity: 0.3 }, a(23.8));
    ft(tl, e.flash, { opacity: 0.3 }, { opacity: 0 }, a(23.8), 4 * F, 'power1.out');
    // 24.8 the strike crosses "searched"
    ft(tl, e.strike, { scaleX: 0 }, { scaleX: 1 }, a(24.8) - F, 6 * F, 'power4.out');
    ft(tl, e.word, { color: FG }, { color: MUTED }, a(24.8) - F, 6 * F, 'power2.out');
    // 25.3-25.9 back to the lockup; the shelf returns
    ft(tl, e.lock, { scale: BIG.scale, x: BIG.x, y: BIG.y }, { scale: 1, x: 0, y: 0 }, a(25.3), 0.6, 'expo.inOut');
    ft(tl, e.shelfLayer, { opacity: 0.18 }, { opacity: 1 }, a(25.3), 0.6, 'power2.inOut');
    // 26.1 search field and its caption
    rise(tl, e.search, a(26.1), 0.36);
    rise(tl, e.searchLabel, a(26.1), 0.4);
    // 27.9 all four rows light up; 40091e keeps the marker
    const LIT = { borderColor: TEAL, backgroundColor: '#1f3338' };
    e.shelf.rows.forEach((r) => {
      ft(tl, r.el, { borderColor: LINE, backgroundColor: PANEL }, LIT, a(27.9) - F, 0.26, 'power2.out');
      if (r.data.id !== '40091e')
        ft(tl, r.el, LIT, { borderColor: '#2e5560', backgroundColor: PANEL }, a(28.6), 0.5, 'power2.inOut');
    });
    rise(tl, e.note, a(27.9), 0.33, 14);
    ft(tl, e.leadPath, { strokeDashoffset: LEAD_LEN }, { strokeDashoffset: 0 }, a(27.9) - F, 0.33, 'power2.inOut');
    ft(tl, e.leadDot, { scale: 0 }, { scale: 1 }, a(28.1), 0.26);
    // the search field makes room for the tags
    ft(tl, [e.search, e.searchLabel], { opacity: 1 }, { opacity: 0 }, a(29.05), 0.2, 'power3.in');
    // 29.3 / 29.7 / 30.1 tags cut in on beats
    [29.3, 29.7, 30.1].forEach((t, i) => {
      cut(tl, e.tags[i], { opacity: 0 }, { opacity: 1 }, a(t));
      ft(tl, e.tags[i], { y: 16 }, { y: 0 }, a(t) - 0.006, 0.26);
    });
  }

  FILM.scene('s6', 23.5, 31.0, function (root, tl) {
    root.classList.add('b-scene');
    const e = buildS6(root);
    animS6(tl, e);
    // caret: on / off every 0.5 s (on when the field arrives), a pure function of t
    FILM.hooks.push(function (t) {
      const tt = Math.min(31.0, Math.max(26.0, t));     // constant outside the field's life
      e.caret.style.opacity = Math.floor((tt - 26.0) * 2 + 1e-6) % 2 === 0 ? 1 : 0;
    });
  });

  /* =====================================================================================
   * S7 · Plain text · 31.0 - 36.0   (the paper world)
   * ===================================================================================== */
  const S7 = 31.0;
  /* `cat build.md` and `git diff`, third capture; the tab is drawn as a fixed gap */
  const CAT = [
    ['# desc: build, test and release gotchas', 'b-cmt'],
    ['<b>+1</b>  release by tag: CI publishes it', ''],
    ['<b>+3</b>  run the build before the tests', ''],
    ['<b>+1</b>  CI runs macOS too: no GNU-only flags', ''],
    ['<b>+0</b>  fresh worktree: install deps first', ''],
  ];
  const DIFF = [
    ['-+1 fresh worktree: install deps first', 'b-del'],
    [' +1 release by tag: CI publishes it', 'b-ctx'],
    [' +3 run the build before the tests', 'b-ctx'],
    ['-+0 tests need Docker running', 'b-del'],
    ['++1 CI runs macOS too: no GNU-only flags', 'b-add'],
    ['++0 fresh worktree: install deps first', 'b-add'],
  ];
  /* sheet coordinates: a 40 px gutter for the bracket, the diff column, a caption column */
  const DF = { top: G.head + 12, pitch: 58, h: 54, x: 34, w: 1068 };
  DF.mid = (i) => DF.top + DF.h / 2 + i * DF.pitch;     // centre line of diff line i
  DF.capMid = DF.top + 6 * DF.pitch + 29;                // centre line of the caption row under the diff

  /** The paper layer sits in an overflow-hidden wrapper anchored at the left; tweening the
   *  wrapper's width wipes the layer on or off without moving it. */
  function buildPaper(root) {
    const e = {};
    e.wipe = h.el('div', 'b-wipe', root); e.wipe.style.left = '0px';
    e.layer = h.el('div', 'b-paper', e.wipe); e.layer.style.left = '0px';
    e.hl = FILM.Headline(e.layer, { l1: "It's a plain text file.", l2: 'Read it. Fix it. Review every change.' });
    e.hl.root.classList.add('b-ink');

    e.sheet = place(h.el('div', 'b-sheet', e.layer), G.x, G.y, G.w, G.h);
    const head = h.el('div', 'b-sheet-head', e.sheet, '<span class="b-sheet-dots"><i></i><i></i><i></i></span>');
    const cmds = h.el('div', 'b-cmds', head);
    e.cmdCat = h.el('span', 'b-cmd', cmds, '<b>$</b> cat build.md');
    e.cmdDiff = h.el('span', 'b-cmd', cmds, '<b>$</b> git diff');

    e.cat = CAT.map(([html, cls], i) => {
      const l = h.el('div', 'b-cat ' + cls, e.sheet, html);
      l.style.top = px(G.head + 38 + i * 72);
      return l;
    });
    e.diff = DIFF.map(([text, cls], i) => {
      const l = h.el('div', 'b-diff ' + cls, e.sheet); l.textContent = text;
      place(l, DF.x, DF.top + i * DF.pitch, DF.w);
      return l;
    });

    // captions. Right column: one line each. Left gutter: a bracket joining the two "fresh worktree"
    // lines (first and last), with its caption on a row of its own under the diff.
    const rx = DF.x + DF.w, y0 = DF.mid(0), y3 = DF.mid(3), y4 = DF.mid(4), y5 = DF.mid(5), yc = DF.capMid;
    const headL = (x, y) => '<path class="b-head" d="M' + x + ',' + y + ' l12,-7 v14 z"/>';    // points left
    const headR = (x, y) => '<path class="b-head" d="M' + x + ',' + y + ' l-12,-7 v14 z"/>';   // points right
    const side = (y, text) => {
      const a = h.el('div', 'b-ann', e.sheet,
        '<svg width="10" height="10"><path d="M' + (rx + 15) + ',' + y + ' H' + (rx + 28) + '"/>' + headL(rx + 5, y) + '</svg>');
      place(h.el('span', '', a, text), rx + 38, y - 27);
      return a;
    };
    e.annEvicted = side(y3, 'evicted');
    e.annNew = side(y4, 'new lesson');
    const gx = 15;
    e.annAged = h.el('div', 'b-ann', e.sheet,
      '<svg width="10" height="10"><path d="M' + (DF.x - 12) + ',' + y0 + ' H' + gx + ' V' + yc + ' H' + (DF.x + 4) + ' M' + gx + ',' + y5 + ' H' + (DF.x - 12) + '"/>' +
      headR(DF.x - 2, y0) + headR(DF.x - 2, y5) + '</svg>');
    place(h.el('span', '', e.annAged, 'unused the longest: −1'), DF.x + 18, yc - 27);

    e.foot = h.el('div', 'b-foot', e.layer); e.foot.textContent = 'git versioning is an optional setup';
    place(e.foot, G.x, BELOW + 4);
    return e;
  }

  function animS7(tl, e) {
    const a = (t) => t - S7;
    rollIn(tl, e.hl.l1, a(31.1), 0.36);
    rollIn(tl, e.hl.l2, a(31.1), 0.4);
    // 31.4 the raw file prints whole
    cut(tl, [e.cmdCat].concat(e.cat), { opacity: 0 }, { opacity: 1 }, a(31.4));
    // 33.1 cut to the diff; lines cascade 40 ms apart
    cut(tl, [e.cmdCat].concat(e.cat), { opacity: 1 }, { opacity: 0 }, a(33.1));
    cut(tl, e.cmdDiff, { opacity: 0 }, { opacity: 1 }, a(33.1));
    e.diff.forEach((l, i) => {
      cut(tl, l, { opacity: 0 }, { opacity: 1 }, a(33.1) + i * 0.04);
      ft(tl, l, { x: -18 }, { x: 0 }, a(33.1) + i * 0.04 - 0.006, 0.2);
    });
    fade(tl, e.foot, a(33.1), 0.3);
    // three captions
    [[e.annEvicted, 33.5, 16], [e.annNew, 33.8, 16], [e.annAged, 34.1, -16]].forEach(([el, t, dx]) =>
      ft(tl, el, { opacity: 0, x: dx }, { opacity: 1, x: 0 }, a(t) - F, 0.33));
  }

  FILM.scene('s7', 31.0, 36.0, function (root, tl) {
    root.classList.add('b-scene');
    // under the wipe: S6's last frame, frozen
    const dark = h.el('div', 'b-layer', root);
    freeze(animS6, buildS6(dark));
    const e = buildPaper(root);
    ft(tl, e.wipe, { width: 0 }, { width: 1920 }, 0, 10 * F, 'power3.out');
    animS7(tl, e);
  });

  /* =====================================================================================
   * S8 · A store, not a loop · 36.0 - 40.0
   * Laid out on the film's outer margin (the hook and payoff margin), not the shelf edge: at
   * 44 px the commands need cards a third of that width.
   * ===================================================================================== */
  const S8 = 36.0;
  const M8 = 146, W8 = FILM.W - 2 * M8;                      // 146 .. 1774
  const CARD = { y: 440, w: 488, h: 180, gap: 52, x0: M8 + 30 };
  const cardX = (i) => CARD.x0 + i * (CARD.w + CARD.gap);
  const cardCx = (i) => cardX(i) + CARD.w / 2;
  const OUT = { x: M8, y: CARD.y - 38, w: W8, h: CARD.h + 76 };
  const BLOCK = { w: 480, h: 190, y: 694, head: 64, radius: 14 };
  BLOCK.x = (FILM.W - BLOCK.w) / 2;
  const BLOCK_BARS = [350, 262, 312, 206];
  const sep = '<span class="b-sep"> · </span>';
  const CARDS = [
    ['1', 'Retrieve', '<div class="b-card-c">nb list' + sep + 'nb show</div>'],
    ['2', 'Agent works', '<div class="b-card-bars"><i style="width:170px"></i><i style="width:104px"></i><i style="width:60px"></i></div>'],
    ['3', 'Reflect', '<div class="b-card-c">nb vote' + sep + 'nb add</div>'],
  ];

  /** The shelf (p = 0) becomes the notebook block (p = 1): one writer for the whole morph. */
  function layoutBlock(e, p) {
    const s = e.block.style;
    s.left = px(lerp(p, G.x, BLOCK.x)); s.top = px(lerp(p, G.y, BLOCK.y));
    s.width = px(lerp(p, G.w, BLOCK.w)); s.height = px(lerp(p, G.h, BLOCK.h));
    s.borderRadius = px(lerp(p, 18, BLOCK.radius));
    e.blockHead.style.height = px(lerp(p, G.head, BLOCK.head));
    e.blockHead.style.borderRadius = px(lerp(p, 16, BLOCK.radius - 2)) + ' ' + px(lerp(p, 16, BLOCK.radius - 2)) + ' 0 0';
    e.bars.forEach((l, i) => {
      const ls = l.style;
      ls.left = px(lerp(p, 14, 24)); ls.top = px(lerp(p, G.slotY(i), BLOCK.head + 18 + i * 28));
      ls.width = px(lerp(p, G.w - 4 - 28, BLOCK_BARS[i])); ls.height = px(lerp(p, G.rowH, 16));
      ls.borderRadius = px(lerp(p, 12, 8));
      ls.backgroundColor = 'rgba(29,37,49,' + (1 - p).toFixed(3) + ')';
      l.firstChild.style.opacity = l.lastChild.style.opacity = p.toFixed(3);
    });
  }

  function buildS8(root) {
    const e = { morph: { p: 0 } };
    // harness -> store wires: the notebook feeds card 1, card 3 writes back
    const my = BLOCK.y + BLOCK.head + (BLOCK.h - BLOCK.head) / 2, cb = CARD.y + CARD.h;
    const lx = cardCx(0), rx = cardCx(2);
    e.connL = svg('b-conn b-layer', root,
      '<path d="M' + (BLOCK.x - 8) + ',' + my + ' H' + lx + ' V' + (cb + 12) + '"/>' +
      '<path d="M' + (lx - 10) + ',' + (cb + 23) + ' L' + lx + ',' + (cb + 9) + ' L' + (lx + 10) + ',' + (cb + 23) + '"/>');
    const rEnd = BLOCK.x + BLOCK.w + 10;
    e.connR = svg('b-conn b-layer', root,
      '<path d="M' + rx + ',' + (cb + 8) + ' V' + my + ' H' + (rEnd + 3) + '"/>' +
      '<path d="M' + (rEnd + 14) + ',' + (my - 10) + ' L' + rEnd + ',' + my + ' L' + (rEnd + 14) + ',' + (my + 10) + '"/>');

    e.outline = svg('b-outline b-layer', root,
      '<rect x="' + (OUT.x + 1) + '" y="' + (OUT.y + 1) + '" width="' + (OUT.w - 2) + '" height="' + (OUT.h - 2) + '" rx="22"/>');
    const label = h.el('div', 'b-outline-label', e.outline, '<b>YOUR HARNESS</b> · Claude Code, Codex CLI, or your own loop');
    place(label, CARD.x0 - 16, OUT.y - 28);

    e.cards = CARDS.map(([n, title, extra], i) => {
      const c = h.el('div', 'b-card', root,
        '<div class="b-card-t"><span class="b-badge">' + n + '</span><span>' + title + '</span></div>' + extra);
      return place(c, cardX(i), CARD.y, CARD.w, CARD.h);
    });
    e.arrows = [0, 1].map((i) => {
      const x = cardX(i) + CARD.w, y = CARD.y + CARD.h / 2;
      return svg('b-arrow b-layer', root,
        '<path d="M' + (x + 9) + ',' + y + ' H' + (x + 43) + ' M' + (x + 33) + ',' + (y - 10) + ' L' + (x + 43) + ',' + y + ' L' + (x + 33) + ',' + (y + 10) + '"/>');
    });

    // the notebook block; it starts as the shelf rectangle and shrinks into place
    e.block = h.el('div', 'b-block', root);
    Object.assign(e.block.style, { borderWidth: '2px', borderColor: LINE, backgroundColor: '#111722' });
    e.blockHead = h.el('div', 'b-block-head', e.block);
    e.blockLabel = h.el('div', 'b-block-label', e.blockHead, '<b>build</b> · 4 lessons');
    e.bars = [0, 1, 2, 3].map(() => h.el('i', '', e.block, '<b></b><b></b>'));
    layoutBlock(e, 0);

    e.hl = FILM.Headline(root, { x: M8, w: W8, l1: 'A store, not a loop.', l2: 'Your harness drives it.' });
    e.quiet = h.el('div', 'b-quiet', root); e.quiet.textContent = 'Large-scale retrieval? Use a real vector store.';
    place(e.quiet, M8, 936);
    return e;
  }

  function animS8(tl, e) {
    const a = (t) => t - S8;
    // 36.0-36.5 the shelf becomes the small notebook block
    ft(tl, e.morph, { p: 0 }, { p: 1 }, 0, 0.5, 'expo.inOut', { onUpdate: function () { layoutBlock(e, e.morph.p); } });
    fade(tl, e.blockLabel, a(36.5), 0.3);
    rollIn(tl, e.hl.l1, a(36.2));
    // 36.3 / 36.6 / 36.9 cards; the outline comes with the first, each arrow with the next card
    fade(tl, e.outline, a(36.3), 0.3);
    [36.3, 36.6, 36.9].forEach((t, i) => {
      rise(tl, e.cards[i], a(t), 0.3, 22);
      if (i > 0) ft(tl, e.arrows[i - 1], { opacity: 0, x: -10 }, { opacity: 1, x: 0 }, a(t) - F, 0.3);
    });
    // the store is wired to cards 1 and 3
    fade(tl, [e.connL, e.connR], a(37.2), 0.4);
    rollIn(tl, e.hl.l2, a(37.8), 0.4);
    // 38.3 the honest caption; fully gone before 39.95
    ft(tl, e.quiet, { opacity: 0, y: 12 }, { opacity: 1, y: 0 }, a(38.3) - F, 0.4);
    ft(tl, e.quiet, { opacity: 1 }, { opacity: 0 }, a(39.74), 0.18, 'power3.in');
  }

  FILM.scene('s8', 36.0, 40.0, function (root, tl) {
    root.classList.add('b-scene');
    animS8(tl, buildS8(root));
    // over it: S7's last frame, frozen; the paper draws back to the left
    const p = buildPaper(root);
    freeze(animS7, p);
    ft(tl, p.wipe, { width: 1920 }, { width: 0 }, 0, 8 * F, 'power3.out');
  });

  /* =====================================================================================
   * S10 · Payoff · 40.0 - 43.5
   * The hook's picture, rebuilt. HOOK mirrors S1_GEOMETRY at the top of scenes-a.js (stage pixels at
   * world scale 1.00, 146 px margin) and the b- classes for this scene mirror the a- classes of S1
   * in scenes-a.css. They are copies, not run-time reads: scenes-a.js is not loaded on this file's
   * dev page. If S1's geometry changes, change the numbers here to match.
   * ===================================================================================== */
  const S10 = 40.0;
  const HOOK = {
    margin: 146,
    eyebrow: { x: 146, y: 150 },
    day: { x: 146, y: 190, w: 1200, maskH: 300, fontSize: 232, lineHeight: 290, fontWeight: 600, letterSpacing: '-0.025em', glyphInset: 8 },
    tally: { right: 1774, y: 326, box: 104, gap: 20, radius: 16, border: 2, cross: 52 },
    term: { x: 146, y: 524, w: 1628, h: 290, radius: 18, border: 2, headH: 68, lineX: 44, line1Y: 90, line2Y: 174, fontSize: 56, lineHeight: 84 },
    sub: { x: 146, y: 852, w: 1500, maskH: 96, fontSize: 64, lineHeight: 90 },
    push: { from: 1.0, to: 1.03, originX: 960, originY: 540 },
  };
  const tallyX = (i, n) => HOOK.tally.right - (n - i) * HOOK.tally.box - (n - 1 - i) * HOOK.tally.gap;
  /* neither mark is in the film fonts: both are drawn. CROSS mirrors S1_CROSS_SVG. */
  const CROSS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="b-x" d="M5 5L19 19M19 5L5 19"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="b-ok" d="M4.5 12.5L10 18L19.5 6.5"/></svg>';
  /* The note needs a band above the terminal that S1 does not have: at 40.4 the day word group
   * moves up and the terminal group moves down, and the note row lands in the opening. */
  const NOTE = { up: 50, down: 35, h: G.rowH, gap: 20 };
  const PASS = 42.1, TYPE0 = 41.0, TYPE1 = 41.8;

  function buildS10(root) {
    const g = HOOK, e = {};
    const origin = px(g.push.originX) + ' ' + px(g.push.originY);
    e.push = h.el('div', 'b-world', root); e.push.style.transformOrigin = origin;
    e.punch = h.el('div', 'b-world', e.push); e.punch.style.transformOrigin = origin;

    // upper group: eyebrow, day word, tally
    e.upper = h.el('div', 'b-layer', e.punch);
    const eyebrow = h.el('div', 'eyebrow b-eyebrow1', e.upper); eyebrow.textContent = 'YOUR AI AGENT';
    place(eyebrow, g.eyebrow.x, g.eyebrow.y);
    const dayMask = place(h.el('div', 'b-day-mask', e.upper), g.day.x - g.day.glyphInset, g.day.y, g.day.w, g.day.maskH);
    const day = h.el('div', 'b-day', dayMask); day.textContent = 'Thursday';
    Object.assign(day.style, { left: px(g.day.glyphInset), fontSize: px(g.day.fontSize), lineHeight: px(g.day.lineHeight),
      fontWeight: g.day.fontWeight, letterSpacing: g.day.letterSpacing });
    for (let i = 0; i < 4; i++) {
      const slot = h.el('div', 'b-slot' + (i < 3 ? ' b-failed' : ''), e.upper, i < 3 ? CROSS : '');
      place(slot, tallyX(i, 4), g.tally.y, g.tally.box, g.tally.box);
      slot.style.borderRadius = px(g.tally.radius);
      if (i < 3) Object.assign(slot.firstChild.style, { width: px(g.tally.cross), height: px(g.tally.cross) });
      else {
        e.slotPass = h.el('div', 'b-slot-pass', slot); e.slotPass.style.borderRadius = px(g.tally.radius);
        e.slotCheck = h.el('div', '', e.slotPass, CHECK);
        Object.assign(e.slotCheck.firstChild.style, { width: px(g.tally.cross), height: px(g.tally.cross) });
      }
    }

    // the note: one shelf row, as wide as the terminal
    e.note = place(h.el('div', 'b-noterow', e.punch), g.term.x, g.term.y + NOTE.down - NOTE.gap - NOTE.h, g.term.w, NOTE.h);
    const row = h.el('div', 'row hot', e.note);
    h.el('span', 'row-id', row).textContent = ROWS[0].id;
    h.el('span', 'row-score', row).textContent = FILM.fmtScore(ROWS[0].score);
    h.el('span', 'row-text', row).textContent = ROWS[0].text;

    // lower group: terminal panel and sub line
    e.lower = h.el('div', 'b-layer', e.punch);
    const term = place(h.el('div', 'b-term', e.lower), g.term.x, g.term.y, g.term.w, g.term.h);
    term.style.borderRadius = px(g.term.radius);
    h.el('span', 'shelf-dots', h.el('div', 'shelf-head', term), '<i></i><i></i><i></i>');
    const lineStyle = (top) => ({ left: px(g.term.lineX), top: px(top), fontSize: px(g.term.fontSize), lineHeight: px(g.term.lineHeight) });
    const l1 = h.el('div', 'b-tline', term, '<span class="b-prompt">$ </span>'); Object.assign(l1.style, lineStyle(g.term.line1Y));
    e.cmd = h.el('span', '', l1);
    e.caret = h.el('span', 'b-tcaret', l1);
    e.l2 = h.el('div', 'b-tline b-l2', term, '<span class="b-xch">' + CHECK + '</span> tests passed');
    Object.assign(e.l2.style, lineStyle(g.term.line2Y));
    e.passEdge = h.el('div', 'b-term-pass', term); e.passEdge.style.borderRadius = px(g.term.radius);
    const subMask = place(h.el('div', 'b-sub-mask', e.lower), g.sub.x, g.sub.y, g.sub.w, g.sub.maskH);
    e.sub = h.el('div', 'b-sub', subMask); e.sub.textContent = 'Reads the note first.';
    Object.assign(e.sub.style, { fontSize: px(g.sub.fontSize), lineHeight: px(g.sub.lineHeight) });
    caretAt(e, S10);
    return e;
  }

  /** Terminal caret: blinks while waiting, solid while typing, gone once the result is in. */
  function caretAt(e, t) {
    let on = Math.floor((t - S10) / 0.5 + 1e-6) % 2 === 0;
    if (t >= TYPE0 - 1e-6) on = true;
    if (t >= PASS - 1e-6) on = false;
    e.caret.style.opacity = on ? 1 : 0;
  }

  function animS10(tl, e) {
    const a = (t) => t - S10, g = HOOK;
    // a slow push, as in the hook; it ends on the scene's last frame so the frozen copy in S9 matches it
    ft(tl, e.push, { scale: 1 }, { scale: 1.02 }, 0, 3.5 - F - 0.002, 'none');
    // 40.4 the note slides in above the terminal; the picture opens to take it
    ft(tl, e.upper, { y: 0 }, { y: -NOTE.up }, a(40.4) - F, 10 * F);
    ft(tl, e.lower, { y: 0 }, { y: NOTE.down }, a(40.4) - F, 10 * F);
    ft(tl, e.note, { opacity: 0, x: -90 }, { opacity: 1, x: 0 }, a(40.4) - F, 10 * F);
    ft(tl, e.sub, { y: g.sub.maskH + 4 }, { y: 0 }, a(40.4) - F, 10 * F);
    // 41.0-41.8 the command is typed
    const CMD = 'npm run build && npm test';
    h.type(tl, e.cmd, CMD, a(TYPE0), CMD.length / (TYPE1 - TYPE0));
    // 42.1 it passes
    cut(tl, [e.l2, e.passEdge, e.slotPass], { opacity: 0 }, { opacity: 1 }, a(PASS));
    ft(tl, e.slotCheck, { scale: 1.9 }, { scale: 1 }, a(PASS) - 0.006, 8 * F);
    ft(tl, e.punch, { scale: 1 }, { scale: 1.04 }, a(PASS) - 0.006, 2 * F, 'power2.out');
    ft(tl, e.punch, { scale: 1.04 }, { scale: 1 }, a(PASS) - 0.006 + 2 * F, 9 * F, 'expo.out');
  }

  FILM.scene('s10', 40.0, 43.5, function (root, tl) {
    root.classList.add('b-scene');
    const e = buildS10(root);
    animS10(tl, e);
    FILM.hooks.push(function (t) { caretAt(e, Math.min(S9 - 1e-3, Math.max(S10, t))); });
  });

  /* =====================================================================================
   * S9 · End card · 43.5 - 49.0   (fourth big cut at 43.8)
   * ===================================================================================== */
  const S9 = 43.5;
  const MARK = { x: 260, y: 150, w: 178, h: 140 };
  const MARK_LINES = [116, 86, 102, 64];
  const WM = { x: MARK.x + MARK.w + 40, y: 94 };            // text box; baseline lands on the mark's foot
  const LOCK9 = { ox: 945, oy: 222, drop: 318 };            // lockup centre; it cuts in on the stage centre line

  FILM.scene('s9', 43.5, 49.0, function (root, tl) {
    root.classList.add('b-scene');
    const a = (t) => t - S9;
    // an opaque ground with its own still dot grid, so the end card does not drift
    const bg = h.el('div', 'b-endbg', root);
    const cv = h.el('canvas', '', bg); cv.width = FILM.W; cv.height = FILM.H;
    const g2 = cv.getContext('2d'); g2.fillStyle = 'rgba(140,151,168,0.10)';
    for (let y = 0, r = 0; y < FILM.H; y += 48, r++)
      for (let x = r % 2 ? 0 : 24; x < FILM.W; x += 48) g2.fillRect(x, y, 2, 2);
    ft(tl, bg, { opacity: 0 }, { opacity: 1 }, 0, 8 * F, 'power2.out');

    // 43.5-43.73 the payoff clears: S10's last frame, frozen, fades; two bare frames before the cut
    const old = h.el('div', 'b-layer', root);
    const o = buildS10(old);
    freeze(animS10, o);
    caretAt(o, S9 - 1e-3);
    ft(tl, old, { opacity: 1 }, { opacity: 0 }, 0, 7 * F, 'power2.in');

    // 43.8 hard cut: mark and wordmark on the centre line, a punch and a violet flash under them
    const flash = h.el('div', 'b-flash', root); flash.style.background = '#8d8af0';
    cut(tl, flash, { opacity: 0 }, { opacity: 0.5 }, a(43.8));
    ft(tl, flash, { opacity: 0.5 }, { opacity: 0 }, a(43.8), 5 * F, 'power1.out');

    const lock = h.el('div', 'b-layer', root);
    gsap.set(lock, { transformOrigin: LOCK9.ox + 'px ' + LOCK9.oy + 'px' });
    const mark = place(h.el('div', 'b-mark', lock), MARK.x, MARK.y, MARK.w, MARK.h);
    MARK_LINES.forEach((w, i) => { const l = h.el('i', '', mark, '<b></b><b></b>'); l.style.top = px(18 + 26 * i); l.style.width = px(w); });
    const wm = place(h.el('div', 'b-wm', lock), WM.x, WM.y); wm.textContent = 'agent-notebook';
    cut(tl, lock, { opacity: 0 }, { opacity: 1 }, a(43.8));
    ft(tl, lock, { scale: 1.08, y: LOCK9.drop }, { scale: 1, y: LOCK9.drop }, a(43.8) - 0.006, 8 * F);
    // 44.1-44.6 the lockup rises to the top band
    ft(tl, lock, { y: LOCK9.drop }, { y: 0 }, a(44.1), 0.5, 'expo.inOut');

    // 44.6 tagline, display serif
    const tgMask = place(h.el('div', 'b-mask', root), G.x - 6, 348, G.w + 12, 144);
    const tg = h.el('div', 'b-tagline', tgMask); tg.textContent = 'Small memory, on purpose.'; tg.style.paddingLeft = '6px';
    rollIn(tl, tg, a(44.6), 0.4);

    // 45.6 install line
    const pill = h.el('div', 'b-pill', root, '<b>$</b> npm install -g agent-notebook');
    place(pill, G.x, 544);
    rise(tl, pill, a(45.6), 0.33, 20);

    // 45.9 how to wire it, where it lives, the licence
    const hint = place(h.el('div', 'b-hint', root, 'then wire your harness: <b>examples/</b>'), G.x, 662);
    const ref = place(h.el('div', 'b-small', root), G.x, 720); ref.textContent = 'reference hooks for Claude Code';
    const rule = place(h.el('div', 'b-rule', root), G.x, 800, G.w);
    const url = place(h.el('div', 'b-url', root), G.x, 828); url.textContent = 'github.com/jeanibarz/agent-notebook';
    const lic = place(h.el('div', 'b-small', root), G.x, 888); lic.textContent = 'MIT · zero dependencies · Node.js 18+';
    ft(tl, [hint, ref, rule, url, lic], { opacity: 0, y: 14 }, { opacity: 1, y: 0 }, a(45.9) - F, 0.26);
    // from 46.2 nothing moves
  });
})();
