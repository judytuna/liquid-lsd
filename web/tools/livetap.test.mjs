// ogg.js and livetap.js: pages and packets, and the live tap's decodeAudioData path end to end, joined
// mid-stream the way Icecast hands it out (header pages, then pages from the middle). ffmpeg stands in for
// the browser's decodeAudioData; those tests are skipped where it is missing.
// node --test web/tools/livetap.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { oggCrc, OggReader, PacketJoiner, parsePage, writeOgg, codecInfo, xiphLace, FLAG_BOS, FLAG_CONTINUED } from '../ogg.js';
import { LiveTap } from '../livetap.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** One page's bytes, checksum included. `segments` are the lacing values; `body` the bytes they cover. */
function makePage({ flags = 0, granule = 0, serial = 7, seq = 0, segments, body }) {
  const b = new Uint8Array(27 + segments.length + body.length);
  b.set([0x4f, 0x67, 0x67, 0x53, 0, flags]);
  const dv = new DataView(b.buffer);
  if (granule < 0) { dv.setUint32(6, 0xffffffff, true); dv.setUint32(10, 0xffffffff, true); }
  else { dv.setUint32(6, granule % 4294967296, true); dv.setUint32(10, Math.floor(granule / 4294967296), true); }
  dv.setUint32(14, serial, true);
  dv.setUint32(18, seq, true);
  b[26] = segments.length;
  b.set(segments, 27);
  b.set(body, 27 + segments.length);
  dv.setUint32(22, oggCrc(b), true);
  return b;
}

const bytes = (n, v) => new Uint8Array(n).fill(v);

test('the checksum is Ogg\'s (CRC-32, poly 0x04c11db7, init 0, no reflection)', () => {
  assert.equal(oggCrc(new TextEncoder().encode('123456789')), 0x89a1897f);
});

test('pages are found across chunk boundaries, after garbage, and a bad checksum is skipped', () => {
  const a = makePage({ flags: FLAG_BOS, granule: 0, seq: 0, segments: [3], body: bytes(3, 1) });
  const bad = makePage({ granule: 5, seq: 1, segments: [2], body: bytes(2, 2) });
  bad[28] ^= 0xff; // body changed after the checksum
  const c = makePage({ granule: 2 ** 40 + 3, seq: 2, segments: [4], body: bytes(4, 3) });
  const all = new Uint8Array([...bytes(5, 9), ...a, ...bad, ...c]);
  const r = new OggReader();
  const pages = [];
  for (let i = 0; i < all.length; i += 7) pages.push(...r.push(all.subarray(i, i + 7)));
  assert.equal(pages.length, 2);
  assert.equal(pages[0].flags, FLAG_BOS);
  assert.equal(pages[1].granule, 2 ** 40 + 3);
  assert.equal(pages[1].seq, 2);
});

test('packets join across pages; one begun before we joined is dropped', () => {
  const j = new PacketJoiner();
  // Page 1: a packet continued from a page we never saw (2 bytes), then a 300-byte packet that goes on.
  const p1 = parsePage(makePage({ flags: FLAG_CONTINUED, granule: -1, segments: [2, 255], body: new Uint8Array([...bytes(2, 0), ...bytes(255, 1)]) }));
  assert.deepEqual(j.page(p1), []);
  // Page 2: the rest of it (45 bytes), then a 10-byte packet.
  const p2 = parsePage(makePage({ flags: FLAG_CONTINUED, granule: 1000, segments: [45, 10], body: new Uint8Array([...bytes(45, 1), ...bytes(10, 2)]) }));
  const out = j.page(p2);
  assert.equal(out.length, 2);
  assert.equal(out[0].data.length, 300);
  assert.ok(out[0].data.every((v) => v === 1));
  assert.equal(out[0].granule, -1);
  assert.equal(out[1].data.length, 10);
  assert.equal(out[1].granule, 1000);
});

test('writeOgg renumbers pages and writes their checksums again', () => {
  const p = [5, 9, 12].map((seq) => parsePage(makePage({ seq, segments: [1], body: bytes(1, seq) })));
  const file = writeOgg(p);
  const back = new OggReader().push(file);
  assert.deepEqual(back.map((q) => q.seq), [0, 1, 2]);
});

test('xiphLace: count - 1, the sizes of all but the last packet, then the packets', () => {
  const laced = xiphLace([bytes(30, 1), bytes(300, 2), bytes(5, 3)]);
  assert.deepEqual([...laced.subarray(0, 4)], [2, 30, 255, 45]);
  assert.equal(laced.length, 4 + 335);
});

// --- end to end, with ffmpeg ---

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livetap-'));
function ffmpeg(args, input) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { input, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return r.stdout;
}
/** decodeAudioData as ffmpeg does it: mono float at `rate`. */
function fakeCtx(rate = 44100) {
  return {
    sampleRate: rate,
    decodeAudioData(buf) {
      return new Promise((resolve, reject) => {
        try {
          const raw = ffmpeg(['-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', String(rate), 'pipe:1'], Buffer.from(buf));
          const pcm = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
          resolve({ numberOfChannels: 1, sampleRate: rate, getChannelData: () => pcm });
        } catch (err) { reject(err); }
      });
    },
  };
}

function serve(body) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'audio/ogg');
      let at = 0;
      const step = () => { // in pieces, like a network
        if (at >= body.length) { res.end(); return; }
        res.write(body.subarray(at, at + 4000)); at += 4000; setImmediate(step);
      };
      step();
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function tapAll(url, ctx) {
  const tap = new LiveTap(url, ctx);
  tap.start();
  for (let i = 0; i < 400 && !tap.ended && !tap.failed; i++) await new Promise((r) => setTimeout(r, 25));
  // The last cuts decode: wait until nothing new has come for half a second (10 s at most).
  for (let last = -1, still = 0, i = 0; i < 200 && still < 10; i++) {
    await new Promise((r) => setTimeout(r, 50));
    still = tap.t === last ? still + 1 : 0;
    last = tap.t;
  }
  const parts = tap.take(Infinity);
  const n = parts.reduce((s, b) => s + b.pcm.length, 0);
  const pcm = new Float32Array(n);
  let at = 0;
  for (const b of parts) { pcm.set(b.pcm, at); at += b.pcm.length; }
  return { tap, pcm };
}

test('the tap decodes a stream joined mid-way, cut by cut, with no gaps or repeats', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  // 8 s of a rising tone (every moment is different, so a gap or a repeat shows), Vorbis mono 44.1 kHz.
  const file = path.join(dir, 'tone.ogg');
  ffmpeg(['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*(200*t+40*t*t))':s=44100:d=8", '-ac', '1', '-c:a', 'libvorbis', '-b:a', '96k', '-y', file]);
  const whole = new Uint8Array(fs.readFileSync(file));
  const pages = new OggReader().push(whole);
  assert.equal(codecInfo(new PacketJoiner().page(pages[0])[0].data).codec, 'vorbis');
  // Icecast: the header pages, then the live pages from wherever the burst begins.
  const headerPages = [];
  const j = new PacketJoiner();
  let headers = 0;
  for (const p of pages) { headerPages.push(p); headers += j.page(p).length; if (headers >= 3) break; }
  const joinAt = Math.floor(pages.length / 3);
  const icecast = new Uint8Array(Buffer.concat([...headerPages, ...pages.slice(joinAt)].map((p) => p.bytes)));

  const srv = await serve(icecast);
  try {
    const { tap, pcm } = await tapAll(`http://127.0.0.1:${srv.address().port}/radio.ogg`, fakeCtx());
    assert.equal(tap.failed, null);
    assert.ok(tap.peak > 0.2, `peak ${tap.peak}`);
    // The reference: the same pages decoded in one go.
    const ref = await fakeCtx().decodeAudioData(icecast.buffer.slice(0));
    const want = ref.getChannelData(0);
    // The tap keeps each cut's own length from the end, so its audio lines up with the reference's end.
    assert.ok(Math.abs(pcm.length - want.length) < 4096, `tap ${pcm.length} vs one go ${want.length}`);
    const off = want.length - pcm.length;
    let worst = 0;
    for (let i = 2048; i < pcm.length - 16; i++) worst = Math.max(worst, Math.abs(pcm[i] - want[i + off]));
    assert.ok(worst < 0.02, `largest difference from decoding in one go: ${worst}`);
  } finally {
    srv.close();
  }
});

test('a stream that is not Vorbis or Opus stops the tap', async () => {
  const page = makePage({ flags: FLAG_BOS, granule: 0, segments: [8], body: new TextEncoder().encode('Speex   ') });
  const srv = await serve(page);
  try {
    const { tap } = await tapAll(`http://127.0.0.1:${srv.address().port}/x.ogg`, fakeCtx());
    assert.match(tap.failed, /not a Vorbis or Opus/);
  } finally {
    srv.close();
  }
});
