/* Shared picture elements. The shelf is the film's one recurring object: it sits in the same
 * rectangle in every scene ("the box never grows"), so its geometry lives here, once.
 * Every scene that shows the shelf builds its own instance in a known state at this geometry;
 * because the rectangle is identical, a cut between scenes reads as one continuous object. */
(function () {
  const h = FILM.h;

  /* Fixed geometry, stage pixels. Do not override per scene. */
  const G = (FILM.SHELF = { x: 260, y: 372, w: 1400, head: 68, rowH: 92, gap: 10, pad: 14, cap: 4 });
  G.h = G.head + G.pad + G.cap * G.rowH + (G.cap - 1) * G.gap + G.pad;   // 508
  G.slotY = (i) => G.head + G.pad + i * (G.rowH + G.gap);                // y of slot i inside the shelf

  /** Build a shelf.
   *  opts.name  title in the header; default 'nb show build' (the rows are that command's output, not the raw file)
   *  opts.rows  [{id, score, text}] placed in slots 0..n-1 (highest score first, as `nb show` prints)
   *  opts.count number shown in the gauge (defaults to rows.length); gauge reads "n / 4"
   *  Returns { root, head, gauge, rows:[row], addRow(data, slot), slotY, row(id) }
   *  row = { el, idEl, scoreEl, textEl, data, slot }; row.el is absolutely positioned: animate its
   *  `y` (gsap) relative to slotY(row.slot), never its `top`. */
  FILM.Shelf = function (parent, opts) {
    const root = h.el('div', 'shelf abs', parent);
    Object.assign(root.style, { left: G.x + 'px', top: G.y + 'px', width: G.w + 'px', height: G.h + 'px' });
    const head = h.el('div', 'shelf-head', root);
    h.el('span', 'shelf-dots', head, '<i></i><i></i><i></i>');
    const name = h.el('span', 'shelf-name', head); name.textContent = opts.name || 'nb show build';
    const gauge = h.el('span', 'shelf-gauge', head);
    const rows = [];
    const api = { root, head, name, gauge, rows, slotY: G.slotY, G };
    api.setGauge = function (n) {
      gauge.textContent = n + ' / ' + G.cap + (n >= G.cap ? ' full' : '');
      gauge.classList.toggle('full', n >= G.cap);
    };
    api.addRow = function (data, slot) {
      const el = h.el('div', 'row', root);
      el.style.top = G.slotY(slot) + 'px';
      const idEl = h.el('span', 'row-id', el); idEl.textContent = data.id;
      const scoreEl = h.el('span', 'row-score', el); scoreEl.textContent = FILM.fmtScore(data.score);
      const textEl = h.el('span', 'row-text', el); textEl.textContent = data.text;
      const row = { el, idEl, scoreEl, textEl, data, slot };
      rows.push(row);
      return row;
    };
    api.row = (id) => rows.find((r) => r.data.id === id);
    (opts.rows || []).forEach((d, i) => api.addRow(d, i));
    api.setGauge(opts.count != null ? opts.count : rows.length);
    return api;
  };

  FILM.fmtScore = (n) => '[' + (n >= 0 ? '+' : '') + n + ']';

  /** One-line terminal strip under the shelf: a prompt line and up to two output lines.
   *  Returns { root, cmd, out1, out2 }. Fill `cmd` with h.type(); output lines print whole. */
  FILM.Strip = function (parent) {
    const root = h.el('div', 'strip abs', parent);
    Object.assign(root.style, { left: G.x + 'px', top: (G.y + G.h + 26) + 'px', width: G.w + 'px' });
    const line = h.el('div', 'strip-line', root);
    h.el('span', 'strip-prompt', line, '$ ');
    const cmd = h.el('span', 'strip-cmd', line);
    h.el('span', 'strip-caret', line);
    const out1 = h.el('div', 'strip-out', root);
    const out2 = h.el('div', 'strip-out', root);
    return { root, line, cmd, out1, out2 };
  };

  /** Headline block in the top band: an eyebrow (mono, small) and one or two display lines.
   *  Returns { root, eyebrow, l1, l2 }. Lines sit in masks: tween l1/l2 `yPercent` 110 -> 0 to roll in. */
  FILM.Headline = function (parent, opts) {
    opts = opts || {};
    const root = h.el('div', 'headline abs', parent);
    Object.assign(root.style, { left: (opts.x != null ? opts.x : G.x) + 'px', top: (opts.y != null ? opts.y : 96) + 'px', width: (opts.w || G.w) + 'px' });
    const eyebrow = h.el('div', 'eyebrow', root); eyebrow.textContent = opts.eyebrow || '';
    const m1 = h.el('div', 'hl-mask', root); const l1 = h.el('div', 'hl-line', m1); l1.innerHTML = opts.l1 || '';
    const m2 = h.el('div', 'hl-mask', root); const l2 = h.el('div', 'hl-line hl-sub', m2); l2.innerHTML = opts.l2 || '';
    return { root, eyebrow, l1, l2 };
  };

  /** Ambient background: a faint dot grid on a canvas, drifting as a pure function of t. */
  FILM.Backdrop = function () {
    const c = document.createElement('canvas'); c.width = FILM.W; c.height = FILM.H; c.id = 'backdrop';
    document.getElementById('stage').prepend(c);
    const g = c.getContext('2d');
    FILM.hooks.push(function (t) {
      g.clearRect(0, 0, c.width, c.height);
      const step = 48, off = (t * 6) % step;
      g.fillStyle = 'rgba(140,151,168,0.10)';
      for (let y = -step + off; y < c.height + step; y += step)
        for (let x = (y / step) % 2 ? 0 : step / 2; x < c.width; x += step) g.fillRect(x, y, 2, 2);
    });
  };
})();
