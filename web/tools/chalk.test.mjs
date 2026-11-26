// node --test web/tools/chalk.test.mjs : CHALK (chalk.js) on the chat's connection, several viewers on the fake
// broker: strokes reach everyone, a late viewer gets the board, undo, wipe, wearing off, and junk and floods
// dropped. Never the real room.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChat, CHAN } from '../chat.js';
import { createChalk, TOPIC, GRID, LIFE_MS, FADE_MS, MAX_POINTS, strength, cleanPoints } from '../chalk.js';
import { boardRect } from '../chalklayer.js';
import { createFakeBroker, fakeHistory } from './fakebroker.mjs';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const open = [];
test.afterEach(() => { for (const c of open.splice(0)) c.leave(); });

/** One viewer: a chat with the chalk channel, as ui.js sets them up. `clock` lets a test move time on. */
function viewer(broker, clientId, clock = { t: 0 }, wait = 0) {
  let chalk = null;
  const changes = { n: 0 }, events = [];
  const channel = { topic: TOPIC, onMessage: (p) => chalk?.onMessage(p), onReady: () => chalk?.onReady() };
  const chat = createChat({ clientId, channels: [channel], WebSocketImpl: broker.WebSocket, fetchImpl: fakeHistory([]) });
  chalk = createChalk({ transport: chat, id: clientId, onChange: () => changes.n++, onEvent: (e) => events.push(e),
    now: () => 1e6 + clock.t, random: () => wait });
  open.push(chat);
  return { chat, chalk, changes, events, start: () => chat.start() };
}

async function room(n, clock) {
  const broker = createFakeBroker();
  const vs = [];
  for (let i = 0; i < n; i++) { const v = viewer(broker, `mut00000${i}`, clock, i / n); v.start(); vs.push(v); }
  await tick(50);
  return { broker, vs };
}

const draw = async (chalk, pts, c = 0) => {
  chalk.begin(pts[0], pts[1], c);
  for (let i = 2; i < pts.length; i += 2) chalk.extend(pts[i], pts[i + 1]);
  chalk.end();
  await tick(30);
};

test('a stroke drawn on one screen shows on the others, point for point', async () => {
  const { broker, vs: [a, b, c] } = await room(3);
  await draw(a.chalk, [100, 100, 400, 400, 800, 200, 1200, 900], 3);
  for (const v of [b, c]) {
    const [s] = v.chalk.visible();
    assert.ok(s, 'the stroke arrived');
    assert.deepEqual(s.pts, [100, 100, 400, 400, 800, 200, 1200, 900]);
    assert.equal(s.c, 3);
  }
  assert.equal(a.chalk.visible().length, 1, 'our own stroke comes back once, not twice');
  // Nothing went to the chat's topic or anyone's presence: the app and spaz.org/radio never see the chalk.
  assert.ok(broker.published.filter((p) => p.topic === TOPIC).length >= 1);
  assert.equal(broker.published.filter((p) => p.topic === CHAN).length, 0);
  assert.ok(broker.published.every((p) => p.topic !== TOPIC || (!p.retain && p.qos === 0)));
});

test('a long stroke goes out in pieces as it is drawn, and the pieces join up', async () => {
  const { broker, vs: [a, b] } = await room(2);
  a.chalk.begin(0, 0);
  for (let i = 1; i <= 20; i++) a.chalk.extend(i * 50, i * 20);
  await tick(90); // one SEND_MS flush while still drawing
  assert.ok(b.chalk.visible()[0]?.pts.length >= 4, 'the other screen sees it before the pen lifts');
  for (let i = 21; i <= 40; i++) a.chalk.extend(i * 50, i * 20);
  a.chalk.end();
  await tick(40);
  const pieces = broker.published.filter((p) => p.topic === TOPIC && JSON.parse(p.payload).k === 'd');
  assert.ok(pieces.length >= 2);
  assert.deepEqual(b.chalk.visible()[0].pts, a.chalk.visible()[0].pts);
});

test('a viewer who comes late gets the board from one of the others (only one answers)', async () => {
  const { broker, vs: [a, b] } = await room(2);
  await draw(a.chalk, [10, 10, 2000, 2000]);
  await draw(b.chalk, [3000, 100, 3100, 1500], 1);
  const late = viewer(broker, 'mut0000zz');
  late.start();
  await tick(2000); // REPLY_MIN_MS + REPLY_SPREAD_MS at most
  const got = late.chalk.visible();
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((s) => s.pts), [[10, 10, 2000, 2000], [3000, 100, 3100, 1500]]);
  const boards = broker.published.filter((p) => p.topic === TOPIC && JSON.parse(p.payload).k === 'b');
  assert.equal(boards.length, 1, 'the second page stood down when the first answered');
});

test('undo takes back only your own last stroke, everywhere', async () => {
  const { vs: [a, b] } = await room(2);
  await draw(a.chalk, [10, 10, 500, 500]);
  await draw(b.chalk, [600, 600, 900, 900]);
  await draw(a.chalk, [1000, 10, 1500, 500]);
  assert.equal(b.chalk.visible().length, 3);
  assert.equal(a.chalk.undo(), true);
  await tick(30);
  assert.deepEqual(b.chalk.visible().map((s) => s.pts[0]), [10, 600]);
  assert.equal(a.chalk.undo(), true);
  await tick(30);
  assert.equal(a.chalk.undo(), false, "nothing of ours is left; b's stroke is not ours to take back");
  assert.deepEqual(b.chalk.visible().map((s) => s.pts[0]), [600]);
});

test('the eraser wipes the board for everyone and says who', async () => {
  const { vs: [a, b, c] } = await room(3);
  await draw(a.chalk, [10, 10, 500, 500]);
  await draw(b.chalk, [600, 600, 900, 900]);
  c.chalk.wipe('redwood');
  await tick(40);
  for (const v of [a, b, c]) assert.equal(v.chalk.visible().length, 0);
  assert.deepEqual(a.events, [{ kind: 'wiped', by: 'redwood' }]);
  assert.deepEqual(c.events, [], 'the wiper is not told about their own wipe');
});

test('chalk wears off: full for LIFE_MS, gone after FADE_MS more', async () => {
  const clock = { t: 0 };
  const { vs: [a, b] } = await room(2, clock);
  await draw(a.chalk, [10, 10, 500, 500]);
  clock.t = LIFE_MS - 1;
  assert.equal(b.chalk.visible()[0].a, 1);
  clock.t = LIFE_MS + FADE_MS / 2;
  assert.ok(Math.abs(b.chalk.visible()[0].a - 0.5) < 0.01);
  clock.t = LIFE_MS + FADE_MS + 1;
  assert.equal(b.chalk.visible().length, 0);
  assert.equal(b.chalk.strokes.size, 0, 'and it is dropped, not kept');
  assert.equal(strength(0), 1);
});

test('junk, oversized and out-of-range messages are dropped', async () => {
  const { broker, vs: [, b] } = await room(2);
  const inject = (o) => broker.inject(TOPIC, typeof o === 'string' ? o : JSON.stringify(o));
  inject('not json');
  inject({ k: 'd', s: 'mutx.0', c: 0, w: 0, p: [1, 2, 3] });            // odd length
  inject({ k: 'd', s: 'mutx.1', c: 0, w: 0, p: [1, GRID + 1] });        // off the board
  inject({ k: 'd', s: 'mutx.2', c: 99, w: 0, p: [1, 2] });              // no such colour
  inject({ k: 'd', s: '<img onerror=x>', c: 0, w: 0, p: [1, 2] });      // a bad id
  inject({ k: 'd', s: 'mutx.3', c: 0, w: 0, p: [1.5, 2] });             // not whole numbers
  inject({ k: 'b', to: 'mut000001', s: [['mutx.4', 0, 0, -5, [1, 2]]] });
  inject('x'.repeat(70 * 1024));
  await tick(40);
  assert.equal(b.chalk.strokes.size, 0);
  assert.equal(cleanPoints(new Array(MAX_POINTS + 2).fill(1)), null);
});

test('a flood from one sender is cut off; the others still draw', async () => {
  const { broker, vs: [a, b] } = await room(2);
  const big = [];
  for (let i = 0; i < 1000; i++) big.push(i % GRID, (i * 7) % GRID);
  for (let n = 0; n < 12; n++) broker.inject(TOPIC, JSON.stringify({ k: 'd', s: `mutbad.${n}`, c: 0, w: 0, p: big.slice(0, 1200) }));
  await tick(40);
  const fromBad = b.chalk.visible().filter((s) => s.sid.startsWith('mutbad.')).length;
  assert.ok(fromBad <= 6, `the burst allowance stops it (${fromBad} strokes)`);
  await draw(a.chalk, [10, 10, 500, 500]);
  assert.ok(b.chalk.visible().some((s) => s.sid.startsWith('mut000000.')));
});

test('offline: drawing still shows on your own screen, and nothing is sent', async () => {
  const broker = createFakeBroker();
  const v = viewer(broker, 'mut0000aa');
  await draw(v.chalk, [10, 10, 500, 500]); // never started: no connection
  assert.equal(v.chalk.visible().length, 1);
  assert.equal(broker.published.length, 0);
});

test('chat.publish only reaches channel topics, never the chat or presence', async () => {
  const { vs: [a] } = await room(1);
  await assert.rejects(a.chat.publish(CHAN, '{"user":"x","message":"spoof"}'), /not a channel/);
  await assert.rejects(a.chat.publish('presence/mut000000', 'x'), /not a channel/);
});

test('the board is 16:9 and letterboxed in a full screen of another shape', () => {
  assert.deepEqual(boardRect(1600, 900), { x: 0, y: 0, w: 1600, h: 900 });
  const tall = boardRect(1000, 1000);
  assert.equal(tall.w, 1000); assert.equal(tall.h, 562.5); assert.equal(tall.y, 218.75);
  const wide = boardRect(2400, 900);
  assert.equal(wide.w, 1600); assert.equal(wide.x, 400);
});
