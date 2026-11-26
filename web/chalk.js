// chalk.js
// CHALK: everyone watching draws on the TV's glass together, in chalk. No DOM here (chalklayer.js draws it and
// takes the pointer), so the protocol can be tested in node (tools/chalk.test.mjs).
//
// It rides the chat's MQTT connection (chat.js) on its own topic, so the Spaz Radio app, spaz.org/radio and the
// chat log never see it, and there is no server of its own: the board lives only in the open pages.
// - Topic TOPIC, QoS 0, never retained. Every payload is JSON with `k` (kind):
//   d  a piece of a stroke: {k, s: stroke id, c: colour, w: width, p: [x, y, x, y, ...]}. A stroke goes out in
//      pieces while it is drawn (one about every SEND_MS), each starting at the last point of the one before.
//   u  undo one stroke: {k, s}.
//   x  wipe the board: {k, by: name or '', id: the wiper's client id}.
//   h  hello from a new page: {k, id}. One page that has strokes answers, after a random wait, with
//   b  the board: {k, to: id, s: [[stroke id, colour, width, age ms, [points]], ...]}, newest last.
// - Points are whole numbers 0..GRID on a 16:9 board (the TV's screen), so every screen shows the same picture.
// - Chalk wears off: a stroke is full strength for LIFE_MS, then fades out over FADE_MS and is gone. Nothing is
//   stored, and a quiet room always ends with a clean board.

export const TOPIC = 'lsdtv/chalk';
export const GRID = 4095;
export const COLOURS = 6;               // chalklayer.js has the colours (white first)
export const WIDTHS = 2;                // thin, thick
export const LIFE_MS = 4 * 60 * 1000;
export const FADE_MS = 60 * 1000;
export const SEND_MS = 60;              // a stroke being drawn goes out about 16 times a second
export const MIN_STEP = 6;              // points closer than this (in grid units) to the last one are skipped
export const MAX_POINTS = 1200;         // per stroke (600 points); a longer drag starts a new stroke
export const MAX_STROKES = 600;         // on the board; past this the oldest go
export const MAX_PAYLOAD = 64 * 1024;   // a bigger message is not ours
export const SNAPSHOT_BYTES = 48 * 1024;
export const REPLY_MIN_MS = 250, REPLY_SPREAD_MS = 1500;
export const RATE_POINTS = 600;         // points a second one sender may add (a fast scribble is about 120)
export const RATE_BURST = 3000;

const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const sidOk = (s) => typeof s === 'string' && s.length > 0 && s.length <= 40 && /^[\w.-]+$/.test(s);
const senderOf = (sid) => sid.slice(0, sid.lastIndexOf('.') > 0 ? sid.lastIndexOf('.') : sid.length);

/** A flat [x, y, ...] list of grid points, or null when it is not one. */
export function cleanPoints(p) {
  if (!Array.isArray(p) || p.length < 2 || p.length % 2 || p.length > MAX_POINTS) return null;
  for (const n of p) if (!isInt(n, 0, GRID)) return null;
  return p;
}

/** How strong a stroke drawn `age` ms ago shows: 1, then down to 0 over FADE_MS. */
export function strength(age) {
  if (age <= LIFE_MS) return 1;
  return Math.max(0, 1 - (age - LIFE_MS) / FADE_MS);
}

/**
 * The shared board. `transport` is {publish(topic, payload) -> Promise, online: bool} (the chat), `id` our client
 * id. `onChange()` fires when the picture changes; `onEvent({kind: 'wiped', by})` for things worth saying.
 */
export function createChalk({
  transport, id, onChange = () => {}, onEvent = () => {},
  now = () => Date.now(), random = Math.random,
  setTimeoutImpl = (f, ms) => setTimeout(f, ms), clearTimeoutImpl = (t) => clearTimeout(t),
} = {}) {
  const strokes = new Map();     // stroke id -> {sid, c, w, pts, born}; Map order is drawing order
  const buckets = new Map();     // sender -> {tokens, at}: the rate limit
  let seq = 0, mine = [], drawing = null, flushTimer = null, replyTimer = null, replyTo = null;

  const send = (msg) => {
    if (!transport?.online) return;
    transport.publish(TOPIC, JSON.stringify(msg)).catch(() => {});
  };
  const changed = () => { try { onChange(); } catch { /* the page's bug, not the board's */ } };

  function trim() {
    while (strokes.size > MAX_STROKES) strokes.delete(strokes.keys().next().value);
  }
  /** Lets a sender add `n` points, or says no (a flood is dropped, not drawn). */
  function allow(sender, n) {
    const t = now();
    const b = buckets.get(sender) ?? { tokens: RATE_BURST, at: t };
    b.tokens = Math.min(RATE_BURST, b.tokens + ((t - b.at) / 1000) * RATE_POINTS);
    b.at = t;
    buckets.set(sender, b);
    if (buckets.size > 200) buckets.delete(buckets.keys().next().value);
    if (b.tokens < n) return false;
    b.tokens -= n;
    return true;
  }
  function addPiece(sid, c, w, pts, born) {
    let s = strokes.get(sid);
    if (!s) {
      s = { sid, c, w, pts: [], born };
      strokes.set(sid, s);
      trim();
    }
    s.born = born; // a stroke wears off from when it was finished
    // A piece starts where the last one ended: skip that point instead of drawing it twice.
    const from = s.pts.length >= 2 && pts[0] === s.pts[s.pts.length - 2] && pts[1] === s.pts[s.pts.length - 1] ? 2 : 0;
    const room = MAX_POINTS - s.pts.length;
    if (room <= 0) return;
    for (let i = from; i < pts.length && i - from < room; i++) s.pts.push(pts[i]);
  }

  /** A message on TOPIC from anyone (our own come back too, and are skipped). */
  function onMessage(payload) {
    if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD) return;
    let m;
    try { m = JSON.parse(payload); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.k === 'd') {
      if (!sidOk(m.s) || !isInt(m.c, 0, COLOURS - 1) || !isInt(m.w, 0, WIDTHS - 1)) return;
      if (senderOf(m.s) === id) return; // ours: already on the board
      const pts = cleanPoints(m.p);
      if (!pts || !allow(senderOf(m.s), pts.length / 2)) return;
      addPiece(m.s, m.c, m.w, pts, now());
      changed();
    } else if (m.k === 'u') {
      if (sidOk(m.s) && strokes.delete(m.s)) changed();
    } else if (m.k === 'x') {
      if (m.id === id) return; // ours, back from the broker: already wiped
      const by = typeof m.by === 'string' ? m.by.slice(0, 32) : '';
      strokes.clear();
      mine = [];
      drawing = null;
      changed();
      onEvent({ kind: 'wiped', by });
    } else if (m.k === 'h') {
      if (!sidOk(m.id) || m.id === id || !alive().length) return;
      // Somebody new: one of us answers. Wait a random moment, and stand down if another page answers first.
      if (replyTimer) return;
      replyTo = m.id;
      replyTimer = setTimeoutImpl(() => { replyTimer = null; sendBoard(replyTo); }, REPLY_MIN_MS + random() * REPLY_SPREAD_MS);
    } else if (m.k === 'b') {
      if (!sidOk(m.to)) return;
      if (m.to === replyTo && replyTimer) { clearTimeoutImpl(replyTimer); replyTimer = null; }
      if (m.to !== id || !Array.isArray(m.s)) return;
      const t = now();
      let any = false;
      for (const row of m.s.slice(-MAX_STROKES)) {
        if (!Array.isArray(row) || row.length !== 5) continue;
        const [sid, c, w, age, p] = row;
        if (!sidOk(sid) || !isInt(c, 0, COLOURS - 1) || !isInt(w, 0, WIDTHS - 1) || !isInt(age, 0, LIFE_MS + FADE_MS)) continue;
        const pts = cleanPoints(p);
        if (!pts) continue;
        const have = strokes.get(sid);
        if (have && have.pts.length >= pts.length) continue; // we saw it ourselves, at least as far
        strokes.delete(sid);
        strokes.set(sid, { sid, c, w, pts: pts.slice(), born: t - age });
        any = true;
      }
      if (any) { trim(); changed(); }
    }
  }

  function alive() {
    const t = now();
    return [...strokes.values()].filter((s) => strength(t - s.born) > 0);
  }
  function sendBoard(to) {
    const t = now();
    const rows = [];
    let bytes = 0;
    const list = alive();
    for (let i = list.length - 1; i >= 0; i--) { // newest first while counting, so the cut takes the oldest
      const s = list[i];
      const row = [s.sid, s.c, s.w, Math.min(LIFE_MS + FADE_MS, Math.max(0, Math.round(t - s.born))), s.pts];
      bytes += JSON.stringify(row).length + 1;
      if (bytes > SNAPSHOT_BYTES) break;
      rows.push(row);
    }
    rows.reverse();
    if (rows.length) send({ k: 'b', to, s: rows });
  }

  function flush() {
    clearTimeoutImpl(flushTimer);
    flushTimer = null;
    const d = drawing;
    if (!d || d.sent >= d.s.pts.length) return;
    const from = Math.max(0, d.sent - 2); // start at the last point sent, so the pieces join
    send({ k: 'd', s: d.s.sid, c: d.s.c, w: d.s.w, p: d.s.pts.slice(from) });
    d.sent = d.s.pts.length;
  }

  return {
    strokes,
    /** The strokes to draw now with their strength (0..1), oldest first. Drops the worn-off ones. */
    visible() {
      const t = now();
      const out = [];
      for (const s of strokes.values()) {
        const a = strength(t - s.born);
        if (a <= 0) { strokes.delete(s.sid); continue; }
        out.push({ ...s, a });
      }
      mine = mine.filter((sid) => strokes.has(sid));
      return out;
    },
    /** After every (re)connect: ask whoever is here for the board. */
    onReady() { send({ k: 'h', id }); },
    onMessage,
    /** Starts a stroke of ours at grid point (x, y). */
    begin(x, y, c = 0, w = 0) {
      if (drawing) this.end();
      const s = { sid: `${id}.${(seq++).toString(36)}`, c: isInt(c, 0, COLOURS - 1) ? c : 0, w: isInt(w, 0, WIDTHS - 1) ? w : 0,
        pts: [clampG(x), clampG(y)], born: now() };
      strokes.set(s.sid, s);
      trim();
      mine.push(s.sid);
      drawing = { s, sent: 0 };
      changed();
      flushTimer = setTimeoutImpl(flush, SEND_MS);
    },
    /** Adds a point to the stroke being drawn. */
    extend(x, y) {
      const d = drawing;
      if (!d) return;
      x = clampG(x); y = clampG(y);
      const p = d.s.pts;
      if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) < MIN_STEP) return;
      if (p.length >= MAX_POINTS) { const { c, w } = d.s; this.end(); this.begin(x, y, c, w); return; }
      p.push(x, y);
      d.s.born = now(); // a stroke wears off from when it was finished
      changed();
      if (!flushTimer) flushTimer = setTimeoutImpl(flush, SEND_MS);
    },
    end() {
      if (!drawing) return;
      flush();
      drawing = null;
    },
    get drawing() { return !!drawing; },
    /** Takes back our newest stroke still on the board. */
    undo() {
      if (drawing) this.end();
      while (mine.length) {
        const sid = mine.pop();
        if (strokes.delete(sid)) { send({ k: 'u', s: sid }); changed(); return true; }
      }
      return false;
    },
    /** Wipes the board for everyone. */
    wipe(by = '') {
      drawing = null;
      strokes.clear();
      mine = [];
      send({ k: 'x', by: String(by).slice(0, 32), id });
      changed();
    },
  };
}

const clampG = (v) => Math.max(0, Math.min(GRID, Math.round(v)));
