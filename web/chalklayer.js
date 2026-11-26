// chalklayer.js
// The chalk on the TV's glass (chalk.js is the shared board): a canvas over the picture that shows everyone's
// strokes, and while a stick is picked up, takes the pointer to draw. The sticks and the eraser are the chat
// blackboard's tray (chatboard.js): pick one up to draw in its colour, the same one again (or B, or Esc) to put
// it down. The eraser wipes the board for everyone; Z (or Ctrl/Cmd+Z) takes back your last stroke. Shift draws
// thick.

import { GRID } from './chalk.js';

/** White first; then the chat's own chalks (tv.css --chalk-yellow, .cb-c0 … .cb-c4). */
export const CHALK_COLOURS = ['#eeebdd', '#f4d06f', '#f2a7b8', '#9fcbea', '#b5e3a1', '#c9b6f0'];
const NAMES = ['white', 'yellow', 'pink', 'blue', 'green', 'lilac'];
const ASPECT = 16 / 9;          // the board is the TV's screen (tv.css --tv-aspect)
const WIDTH = [0.0045, 0.011];  // of the board's width: thin, thick
const FADE_TICK_MS = 500;       // how often a fading board is redrawn

/** The 16:9 board inside a box of `w` x `h` (letterboxed in a full screen of another shape). */
export function boardRect(w, h) {
  const bw = Math.min(w, h * ASPECT), bh = bw / ASPECT;
  return { x: (w - bw) / 2, y: (h - bh) / 2, w: bw, h: bh };
}

export function createChalkLayer({ chalk, screen, tray = null, say = () => {}, onDrawing = () => {}, start = () => {}, nick = () => '', doc = document, win = window }) {
  const canvas = doc.createElement('canvas');
  canvas.id = 'chalkCanvas';
  canvas.setAttribute('aria-hidden', 'true');
  screen.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // A grain to rub out of the strokes, so they read as chalk and not as felt pen.
  const grain = doc.createElement('canvas');
  grain.width = grain.height = 96;
  {
    const g = grain.getContext('2d');
    const img = g.createImageData(96, 96);
    for (let i = 0; i < img.data.length; i += 4) img.data[i + 3] = Math.random() < 0.28 ? 120 + Math.random() * 135 : 0;
    g.putImageData(img, 0, 0);
  }
  const grainPattern = ctx.createPattern(grain, 'repeat');

  let colour = 0, drawingMode = false, pointer = null, dirty = true, frame = 0, fadeTimer = null;
  const sticks = [];
  let eraser = null;

  // --- The tray: one stick per colour, and the eraser ---
  if (tray) {
    tray.replaceChildren();
    tray.classList.add('ck-tray');
    CHALK_COLOURS.forEach((c, i) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'ck-stick';
      b.style.setProperty('--ck', c);
      b.title = `Draw on the TV in ${NAMES[i]} chalk (B)`;
      b.setAttribute('aria-label', `${NAMES[i]} chalk`);
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => (drawingMode && colour === i ? setDrawing(false) : (colour = i, setDrawing(true))));
      sticks.push(b);
    });
    eraser = doc.createElement('button');
    eraser.type = 'button';
    eraser.className = 'ck-eraser';
    eraser.title = 'Wipe the chalk off the TV, for everyone';
    eraser.setAttribute('aria-label', 'Wipe the chalk for everyone');
    eraser.addEventListener('click', () => wipe());
    tray.append(...sticks, eraser);
  }
  function renderTray() {
    sticks.forEach((b, i) => {
      const on = drawingMode && i === colour;
      b.classList.toggle('up', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  // --- Drawing mode ---
  function setDrawing(on) {
    if (on === drawingMode) { renderTray(); return; }
    drawingMode = on;
    if (on) start(); // the board rides the chat's connection: connect if it is not up yet
    if (!on && pointer) { chalk.end(); pointer = null; }
    doc.body.classList.toggle('chalk-drawing', on);
    renderTray();
    onDrawing(on);
    say(on ? `CHALK: DRAW ON THE TV · B TO STOP` : 'CHALK DOWN');
  }
  function wipe() {
    if (!chalk.strokes.size) { say('THE BOARD IS CLEAN'); return; }
    chalk.wipe(nick());
    say('CHALK WIPED');
  }

  // --- The pointer ---
  const toGrid = (e) => {
    const r = canvas.getBoundingClientRect();
    const b = boardRect(r.width, r.height);
    return [((e.clientX - r.left - b.x) / b.w) * GRID, ((e.clientY - r.top - b.y) / b.h) * GRID];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!drawingMode || pointer !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    pointer = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* a synthetic event */ }
    const [x, y] = toGrid(e);
    chalk.begin(x, y, colour, e.shiftKey ? 1 : 0);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointer) return;
    e.preventDefault();
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ev of list.length ? list : [e]) { const [x, y] = toGrid(ev); chalk.extend(x, y); }
  });
  const up = (e) => {
    if (e.pointerId !== pointer) return;
    chalk.end();
    pointer = null;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  // While drawing, clicks and taps on the glass are the chalk's: the TV's own (info, fullscreen, power) wait.
  for (const type of ['click', 'dblclick', 'touchstart', 'touchmove', 'touchend']) {
    canvas.addEventListener(type, (e) => { if (drawingMode) e.stopPropagation(); }, { passive: true });
  }

  // --- Painting ---
  function resize() {
    const dpr = Math.min(2, win.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dirty = true; }
  }
  function paint() {
    frame = 0;
    if (!dirty) return;
    dirty = false;
    resize();
    const W = canvas.width, H = canvas.height;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, H);
    const strokes = chalk.visible();
    canvas.dataset.strokes = String(strokes.length); // for the headless checks
    // A clean board is also hidden: a browser that holds on to the last picture after a wipe (seen in headless
    // Chrome) still shows nothing. The canvas keeps taking the pointer, so drawing on a clean board works.
    canvas.classList.toggle('ck-clean', !strokes.length);
    if (!strokes.length) { setFadeTick(false); return; }
    const b = boardRect(W, H);
    const sx = b.w / GRID, sy = b.h / GRID;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      ctx.globalAlpha = 0.92 * s.a;
      ctx.strokeStyle = ctx.fillStyle = CHALK_COLOURS[s.c] ?? CHALK_COLOURS[0];
      ctx.lineWidth = Math.max(1.5, WIDTH[s.w] * b.w);
      const p = s.pts;
      ctx.beginPath();
      ctx.moveTo(b.x + p[0] * sx, b.y + p[1] * sy);
      if (p.length === 2) ctx.lineTo(b.x + p[0] * sx + 0.01, b.y + p[1] * sy); // a dot
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(b.x + p[i] * sx, b.y + p[i + 1] * sy);
      ctx.stroke();
    }
    // The grain: rub specks out of everything drawn (the canvas is clear elsewhere, so only the chalk shows it).
    ctx.globalAlpha = 0.55;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = grainPattern;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    // Strokes wear off with time, so a board with chalk on it is looked at again now and then.
    setFadeTick(true);
  }
  function setFadeTick(on) {
    if (on && !fadeTimer) fadeTimer = win.setInterval(() => { dirty = true; schedule(); }, FADE_TICK_MS);
    else if (!on && fadeTimer) { win.clearInterval(fadeTimer); fadeTimer = null; }
  }
  function schedule() { if (!frame) frame = win.requestAnimationFrame(paint); }
  const redraw = () => { dirty = true; schedule(); };
  win.addEventListener('resize', redraw);
  doc.addEventListener('fullscreenchange', redraw);
  if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(redraw).observe(canvas);
  redraw();

  return {
    redraw,
    get drawing() { return drawingMode; },
    setDrawing,
    toggle() { setDrawing(!drawingMode); },
    undo() { if (chalk.undo()) say('UNDONE'); },
    wipe,
    canvas,
  };
}
