/* Vertical 9:16 cut of the launch film (1080x1920, 30 fps, 49 s) for Reels and Shorts.
 *
 * The scenes are untouched. vertical.html lays the same live 1920x1080 #stage inside a clipping
 * window on a tall canvas; this file decides, as pure functions of the film time t,
 *   1. which rectangle of the stage the window shows (the crop: a scale and a translate on #stage),
 *   2. which caption phrase is burned in under the window (read from FILM.captions at run time).
 * Nothing here uses a timer, a transition or a random number: a frame depends only on t.
 *
 * CANVAS (y from the top; platform overlays cover y < 250, y > 1500, and x > 950 below y = 960)
 *   254-428    title: brand line + two-line headline (HEADLINE below)
 *   452-1132   picture window, 1080 x 680, full bleed
 *   1180-1336  burned captions, two lines of 64 px, left edge x = 64, never wider than x = 950
 *
 * WHY THE WINDOW IS 680 px TALL. The bounds below were measured, not guessed: for every frame of
 * every scene, the union of the client rects of all visible text nodes and painted boxes inside the
 * scene root (opacity under 0.08, full-stage layers and anything hidden behind an opaque wipe are
 * ignored; overflow masks are honoured). Script: out/v-measure/measure.mjs, data: bounds.json.
 * The film is not centred in a narrow column: every scene has something to read across 1400-1680
 * stage px, so the WIDTH is what limits the scale, at 0.635-0.74 (the 16:9 film letterboxed in the
 * same canvas is 0.5625). The widest window is 1715 stage px; at 680 px tall it shows 1080 stage px
 * of height, so the window never looks past the stage. A taller window would only add empty margin.
 *
 * MEASURED UNIONS (stage px: x0..x1 x y0..y1) AND CHOSEN WINDOWS (x, y, w -> x..x1; scale = 1080 / w)
 *
 * part  time         measured, steady                    worst single frames (may clip)      window (x, y, w)      scale
 * S1    0.0-4.0      118..1798 x 138..957                 shakes at 2.8 / 3.5: 101..1823      106,  5, 1700 -> 1806  0.635
 *                    (text 122..1302; tally to 1798)
 * S2a   4.0-4.5      146..1774 x 344..683 (the cut frame) -                                   134, 20, 1652 -> 1786  0.654
 *                    settles at 215..1705
 * S2b   5.0-7.0      252..1660 x 54..866                  -                                    96, 35, 1590 -> 1686  0.679
 * S3    7.0-10.5     157..1660 x 96..1016                 -                                   (same: chip `you` hangs at 157)
 * S4a   10.5-13.7    123..1660 x 96..952                  -                                   (same: chips `hook` 135, `agent` 123)
 * S4b   13.7-17.0    123..1783 x 80..1004                 -                                   111,  5, 1700 -> 1811  0.635
 *                    (the film pushes to 1.08)
 * S5a   17.0-18.4    123..1660 x 158..952                 -                                   (same; typed command ends at 1606)
 * S5b   18.4-21.6    248..1660 x 158..968                 punch 18.40-18.53: 176..1744 x 49..1070;  228,  8, 1688 -> 1916  0.640
 *                                                         evicted row leaving 20.50-20.57: to 2528
 * S5c   21.6-23.5    260..1712 x 158..1016                -                                   (same)
 *                    (output line ends at 1712; aging caption 1157..1626 x 877..945)
 * S6a   23.8-25.3    131..1791 x 372..866                 the cut frame 23.80: 100..1822      104,  0, 1715 -> 1819  0.630
 * S6b   25.7-31.0    257..1660 x 150..986                 -                                   222, 80, 1554 -> 1776  0.695
 *                    (search caption ends at 1588)
 * S7    31.0-36.0    254..1660 x 150..972                 -                                   (same: the sheet stays where the shelf was)
 *                    (diff captions 1402..1645; bracket at 254)
 * S8    36.0-40.0    146..1744 x 150..998                 -                                   122, 38, 1646 -> 1768  0.656
 * S10   40.0-43.5    129..1791 x 91..979                  note sliding in 40.40: from 99;     106,  5, 1700 -> 1806  0.635
 *                                                         pass punch 42.13-42.17: 105..1815
 * S9a   43.8-44.1    259..1626 x 414..659                 the cut frame 43.80: 213..1671      208, 52, 1482 -> 1690  0.729
 * S9b   44.6-49.0    259..1660 x 98..939                  -                                   230, 58, 1460 -> 1690  0.740
 *
 * How a window was chosen from a union:
 *  - it contains every text rect and every chip, label, caption and tally box of its part on every
 *    frame (checked for all 1470 frames by out/v-measure/check.mjs); only the single frames in the
 *    "may clip" column lose a few px of a box edge or of a row that is already leaving;
 *  - text that lands under canvas y = 960 must end left of canvas x = 950 (the like / comment column).
 *    That, not containment, sets the scale in S5 (the 55-character output line), in S4b-S5a (the typed
 *    command) and in S6b-S7 (the search caption), and it is why those windows sit tight to the left;
 *  - the shelf is the film's one continuous object, so the window does not jump at the scene
 *    boundaries inside S2-S7: it travels by eased moves (10-18 frames), four of them riding a camera
 *    move the film already makes (4.5, 13.7, 25.3, 44.1). It cuts where the film cuts: 4.0, 40.0, and
 *    on the two bare frames before the end card (43.75: inside S9, but nothing is on screen).
 */
(function () {
  /* ---------- the one thing to edit: the headline over the picture (two lines) ---------- */
  const HEADLINE = ['Your AI agent forgets.', 'Give it a notebook.'];
  const BRAND = 'agent-notebook';

  /* ---------- canvas geometry (must match vertical.css) ---------- */
  const WIN = { w: 1080, h: 680 };            // the picture window, canvas px
  const F = 1 / 30;

  /* ---------- crop keyframes ----------
   * [start, frames, ease, x, y, w]: from `start` the window travels to the stage rectangle whose
   * top-left is (x, y) and whose width is w (height = w * 680 / 1080), over `frames` frames with
   * `ease`; frames = 0 is a cut. A move always starts from the previous keyframe's rectangle. */
  const CROP = [
    [0,          0,  null,           106,  5, 1700],   // S1   hook: 146 px margin, slow push to 1.03
    [4,          0,  null,           134, 20, 1652],   // S2a  wordmark on the centre line (first big cut)
    [4.5,        15, 'expo.inOut',    96, 35, 1590],   // S2b-S4a  shelf + gutter chips (travels with the film's lockup move)
    [13.7,       15, 'expo.inOut',   111,  5, 1700],   // S4b  votes (the film pushes to 1.08), S5a the typed lesson
    [18.4,       15, 'power2.inOut', 228,  8, 1688],   // S5b-c  the cap: waiting card, eviction, two-line output
    [704 * F,    10, 'power2.inOut', 104,  0, 1715],   // S6a  "Shown, not searched." at 1.9x (third big cut at 23.8)
    [25.3,       18, 'expo.inOut',   222, 80, 1554],   // S6b-S7  shelf at its lockup, then the paper sheet
    [1076 * F,   10, 'power2.inOut', 122, 38, 1646],   // S8   three cards on the 146 px margin
    [40,         0,  null,           106,  5, 1700],   // S10  payoff: the hook's layout
    [43.75,      0,  null,           208, 52, 1482],   // S9a  end-card cut: mark + wordmark at 1.08 (cut on the two bare frames before 43.8)
    [44.1,       15, 'expo.inOut',   230, 58, 1460],   // S9b  the end card (travels with the lockup's rise)
  ];
  const EASE = {};
  const ease = (name) => EASE[name] || (EASE[name] = gsap.parseEase(name));
  const EPS = 1e-6;

  /** The crop rectangle at time t: {x, y, w} in stage px. Pure. */
  function cropAt(t) {
    let k = 0;
    for (let i = 0; i < CROP.length; i++) if (t + EPS >= CROP[i][0]) k = i;
    const c = CROP[k];
    const dur = c[1] * F;
    if (k === 0 || dur === 0 || t + EPS >= c[0] + dur) return { x: c[3], y: c[4], w: c[5] };
    const p = ease(c[2])(Math.max(0, Math.min(1, (t - c[0]) / dur)));
    const a = CROP[k - 1];
    return { x: a[3] + (c[3] - a[3]) * p, y: a[4] + (c[4] - a[4]) * p, w: a[5] + (c[5] - a[5]) * p };
  }

  /* ---------- captions: FILM.captions, cut into phrases of at most two short lines ----------
   * Deterministic and font-independent: line lengths are estimated from a table of Inter 600 advance
   * widths (thousandths of an em), not measured in the page, so a phrase is the same before and
   * after the web font arrives. */
  const ADV = { ' ': 252, '!': 321, '"': 523, '$': 650, '%': 1004, '&': 663, "'": 326, '(': 373, ')': 373, '+': 673, ',': 319,
    '-': 465, '.': 319, '/': 379, ':': 319, ';': 329, '=': 673, '?': 543, '’': 294, '—': 1000, '…': 956,
    0: 660, 1: 423, 2: 623, 3: 636, 4: 666, 5: 612, 6: 640, 7: 576, 8: 640, 9: 640,
    A: 728, B: 659, C: 737, D: 722, E: 605, F: 588, G: 749, H: 746, I: 277, J: 580, K: 703, L: 565, M: 922, N: 759, O: 769,
    P: 645, Q: 773, R: 652, S: 650, T: 660, U: 736, V: 728, W: 1020, X: 720, Y: 713, Z: 652,
    a: 574, b: 624, c: 583, d: 624, e: 591, f: 389, g: 625, h: 612, i: 262, j: 262, k: 569, l: 262, m: 900, n: 612, o: 609,
    p: 624, q: 624, r: 397, s: 549, t: 353, u: 612, v: 587, w: 839, x: 569, y: 588, z: 566 };
  const em = (s) => { let w = 0; for (const ch of s) w += ADV[ch] != null ? ADV[ch] : 700; return w / 1000; };
  const LINE_EM = 13.4;        // longest line: 13.4 em = 858 px at 64 px, about 24-26 characters
  const PUNCT_BONUS = 1.5;     // em: how much a line break after punctuation is preferred
  const endsClause = (w) => /[,;:.!?—]$/.test(w);

  /** One or two lines for a run of words, or null if it needs more. Two lines are balanced. */
  function lines(words) {
    const all = words.join(' ');
    if (em(all) <= LINE_EM) return [all];
    let best = null, bestCost = Infinity;
    for (let k = 1; k < words.length; k++) {
      const a = words.slice(0, k).join(' '), b = words.slice(k).join(' ');
      const wa = em(a), wb = em(b);
      if (wa > LINE_EM || wb > LINE_EM) continue;
      const cost = Math.max(wa, wb) - (endsClause(words[k - 1]) ? PUNCT_BONUS : 0);
      if (cost < bestCost) { bestCost = cost; best = [a, b]; }
    }
    return best;
  }
  /** Several sentences on one page: each line holds whole sentences. */
  function sentenceLines(sents) {
    if (sents.length === 1) return lines(sents[0].split(' '));
    const all = sents.join(' ');
    if (em(all) <= LINE_EM) return [all];
    let best = null, bestCost = Infinity;
    for (let k = 1; k < sents.length; k++) {
      const a = sents.slice(0, k).join(' '), b = sents.slice(k).join(' ');
      const wa = em(a), wb = em(b);
      if (wa > LINE_EM || wb > LINE_EM) continue;
      if (Math.max(wa, wb) < bestCost) { bestCost = Math.max(wa, wb); best = [a, b]; }
    }
    return best;
  }
  /** A sentence too long for one page: cut it at a clause end if there is a usable one, else near
   *  the point that makes the pages even; the first part must fit a page. */
  function splitLong(words) {
    const whole = lines(words);
    if (whole) return [whole];
    const total = em(words.join(' '));
    const target = total / Math.ceil(total / (2 * LINE_EM));
    let cut = 0, cutCost = Infinity;
    for (let k = 1; k < words.length; k++) {
      const head = words.slice(0, k);
      if (!lines(head)) break;
      const cost = Math.abs(em(head.join(' ')) - target) - (endsClause(words[k - 1]) ? 4 * PUNCT_BONUS : 0);
      if (cost < cutCost) { cutCost = cost; cut = k; }
    }
    if (!cut) cut = 1;                                   // a single word wider than a line: let it stand alone
    return [lines(words.slice(0, cut)) || [words.slice(0, cut).join(' ')]].concat(splitLong(words.slice(cut)));
  }
  /** A caption's text as pages of one or two lines. */
  function pagesOf(text) {
    const sents = text.trim().split(/(?<=[.!?])\s+/).map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    const pages = [];
    for (let i = 0; i < sents.length;) {
      let took = 0;
      for (let j = sents.length; j > i; j--) {
        const l = sentenceLines(sents.slice(i, j));
        if (l) { pages.push(l); took = j - i; break; }
      }
      if (!took) { Array.prototype.push.apply(pages, splitLong(sents[i].split(' '))); took = 1; }
      i += took;
    }
    return pages;
  }
  /** The phrase on screen at t: the caption's pages share its interval in proportion to their length. */
  const pageCache = new Map();                           // text -> pages (a pure function of the text)
  function phraseAt(t) {
    const c = FILM.captions.find((c) => t >= c.t0 && t < c.t1);
    if (!c) return null;
    let pages = pageCache.get(c.text);
    if (!pages) pageCache.set(c.text, pages = pagesOf(c.text));
    const len = pages.map((p) => p.join(' ').length);
    const total = len.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    for (let i = 0; i < pages.length; i++) {
      acc += len[i];
      if (t < c.t0 + (c.t1 - c.t0) * (acc / total) || i === pages.length - 1) return pages[i];
    }
    return null;
  }

  /* ---------- wiring ---------- */
  const stage = document.getElementById('stage');
  const cap = document.getElementById('v-caption');
  const capLines = cap.querySelectorAll('span');
  document.getElementById('v-brand').textContent = BRAND;
  document.querySelectorAll('#v-headline span').forEach((el, i) => { el.textContent = HEADLINE[i] || ''; });

  let shown = null;
  FILM.hooks.push(function (t) {
    const c = cropAt(t);
    const s = WIN.w / c.w;
    stage.style.setProperty('--crop', 'translate(' + (-c.x * s).toFixed(3) + 'px,' + (-c.y * s).toFixed(3) + 'px) scale(' + s.toFixed(5) + ')');
    const p = phraseAt(t);
    const key = p ? p.join('\n') : '';
    if (key !== shown) {
      shown = key;
      capLines[0].textContent = p ? p[0] : '';
      capLines[1].textContent = p && p[1] ? p[1] : '';
    }
  });

  /* live page only: the canvas scales to fit the browser (render mode stays at 1:1) */
  const render = /[?&]render=1/.test(location.search);
  function fit() {
    let s = 1;
    if (!render) {
      const availH = window.innerHeight - 32 - 76;        // shell padding, and the controls (they wrap to two rows)
      s = Math.max(0.1, Math.min(1, (window.innerWidth - 32) / 1080, availH / 1920));
    }
    document.documentElement.style.setProperty('--fit', String(s));   // read by #fit, #frame and #controls
  }
  window.addEventListener('resize', fit);
  fit();

  FILM.vertical = { cropAt, pagesOf, phraseAt, WIN, CROP };   // for the measurement scripts
})();
