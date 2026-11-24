// ogg.js
// Just enough Ogg for livetap.js: split a byte stream into pages, join pages into packets, read the codec
// from the first packet, and write a short Ogg file back out (fresh sequence numbers and checksums) for a
// decoder that only takes whole files. Plain JS with no browser calls, so node can test it.

const CAPTURE = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
const HEADER_LEN = 27;
const MAX_PAGE = HEADER_LEN + 255 + 255 * 255;

export const FLAG_CONTINUED = 0x01;
export const FLAG_BOS = 0x02;
export const FLAG_EOS = 0x04;

// CRC-32 with the polynomial 0x04c11db7, no reflection, initial value 0 (Ogg's own).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

/** Granule position as a Number: -1 when all ones (no packet ends on the page). */
function readGranule(b, at) {
  const lo = b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24);
  const hi = b[at + 4] | (b[at + 5] << 8) | (b[at + 6] << 16) | (b[at + 7] << 24);
  if (lo === -1 && hi === -1) return -1;
  return (hi >>> 0) * 4294967296 + (lo >>> 0);
}

const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/**
 * Splits a byte stream into Ogg pages. Push bytes as they arrive; each call returns the pages completed so
 * far. Garbage, and pages whose checksum does not match, are skipped up to the next "OggS".
 */
export class OggReader {
  constructor() {
    this.buf = new Uint8Array(0);
    this.skipped = 0; // bytes thrown away while looking for a page
  }

  push(chunk) {
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf, 0);
    joined.set(chunk, this.buf.length);
    const b = joined;
    const pages = [];
    let at = 0;
    while (b.length - at >= HEADER_LEN) {
      if (b[at] !== CAPTURE[0] || b[at + 1] !== CAPTURE[1] || b[at + 2] !== CAPTURE[2] || b[at + 3] !== CAPTURE[3] || b[at + 4] !== 0) {
        at++; this.skipped++;
        continue;
      }
      const nSeg = b[at + 26];
      if (b.length - at < HEADER_LEN + nSeg) break;
      let bodyLen = 0;
      for (let i = 0; i < nSeg; i++) bodyLen += b[at + HEADER_LEN + i];
      const len = HEADER_LEN + nSeg + bodyLen;
      if (b.length - at < len) break;
      const bytes = b.slice(at, at + len);
      const want = u32(bytes, 22);
      bytes[22] = bytes[23] = bytes[24] = bytes[25] = 0;
      const ok = oggCrc(bytes) === want;
      bytes[22] = want & 0xff; bytes[23] = (want >>> 8) & 0xff; bytes[24] = (want >>> 16) & 0xff; bytes[25] = want >>> 24;
      if (!ok) { at++; this.skipped++; continue; }
      pages.push(parsePage(bytes));
      at += len;
    }
    // Keep the unfinished tail (at most one page's worth: anything older can't start a page that fits).
    const keepFrom = Math.max(at, b.length - MAX_PAGE);
    this.skipped += keepFrom - at;
    this.buf = b.slice(keepFrom);
    return pages;
  }
}

/** { flags, granule, serial, seq, lacing, body, bytes } of one whole page (bytes: the page as read). */
export function parsePage(bytes) {
  const nSeg = bytes[26];
  return {
    flags: bytes[5],
    granule: readGranule(bytes, 6),
    serial: u32(bytes, 14),
    seq: u32(bytes, 18),
    lacing: bytes.subarray(HEADER_LEN, HEADER_LEN + nSeg),
    body: bytes.subarray(HEADER_LEN + nSeg),
    bytes,
  };
}

/**
 * Joins pages into packets. `page(p)` returns the packets that end on that page, each { data, granule }:
 * granule is the page's granule on the last packet that ends there and -1 on the others. A packet whose
 * start was never seen (the stream was joined mid-packet) is dropped.
 */
export class PacketJoiner {
  constructor() { this.reset(); }

  reset() {
    this.parts = [];
    this.partial = false; // `parts` holds the start of a packet that goes on into the next page
  }

  page(p) {
    const out = [];
    let pos = 0;
    let dropping = (p.flags & FLAG_CONTINUED) !== 0 && !this.partial;
    if (!(p.flags & FLAG_CONTINUED)) this.parts = [];
    let lastEnded = -1;
    for (let i = 0; i < p.lacing.length; i++) {
      const n = p.lacing[i];
      if (!dropping) this.parts.push(p.body.subarray(pos, pos + n));
      pos += n;
      if (n < 255) {
        if (!dropping) {
          out.push({ data: concat(this.parts), granule: -1 });
          lastEnded = out.length - 1;
        }
        this.parts = [];
        dropping = false;
      }
    }
    this.partial = p.lacing.length > 0 && p.lacing[p.lacing.length - 1] === 255 && !dropping;
    if (!this.partial) this.parts = [];
    if (lastEnded >= 0) out[lastEnded].granule = p.granule;
    return out;
  }
}

function concat(parts) {
  if (parts.length === 1) return parts[0].slice();
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const startsWith = (b, s) => b.length >= s.length && [...s].every((c, i) => b[i] === c.charCodeAt(0));

/**
 * The codec from a stream's first packet: { codec, channels, rate, headers, preSkip } where `rate` is the
 * granule rate and `headers` the number of header packets. Null for anything else.
 */
export function codecInfo(first) {
  if (first.length >= 30 && first[0] === 1 && startsWith(first.subarray(1), 'vorbis')) {
    return { codec: 'vorbis', channels: first[11], rate: u32(first, 12), headers: 3, preSkip: 0 };
  }
  if (first.length >= 19 && startsWith(first, 'OpusHead')) {
    return { codec: 'opus', channels: first[9], rate: 48000, headers: 2, preSkip: first[10] | (first[11] << 8) };
  }
  return null;
}

/** Vorbis's three header packets in Xiph lacing: the codec description WebCodecs (and Matroska) take. */
export function xiphLace(packets) {
  const sizes = [];
  for (let i = 0; i < packets.length - 1; i++) {
    let n = packets[i].length;
    while (n >= 255) { sizes.push(255); n -= 255; }
    sizes.push(n);
  }
  let total = 1 + sizes.length;
  for (const p of packets) total += p.length;
  const out = new Uint8Array(total);
  out[0] = packets.length - 1;
  out.set(sizes, 1);
  let at = 1 + sizes.length;
  for (const p of packets) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * One Ogg file from pages of one stream: sequence numbers renumbered from 0 and every checksum written
 * again, so a decoder that wants a whole file takes it. The pages keep their flags and granules.
 */
export function writeOgg(pages) {
  let total = 0;
  for (const p of pages) total += p.bytes.length;
  const out = new Uint8Array(total);
  let at = 0;
  pages.forEach((p, i) => {
    const page = out.subarray(at, at + p.bytes.length);
    page.set(p.bytes);
    page[18] = i & 0xff; page[19] = (i >>> 8) & 0xff; page[20] = (i >>> 16) & 0xff; page[21] = (i >>> 24) & 0xff;
    page[22] = page[23] = page[24] = page[25] = 0;
    const crc = oggCrc(page);
    page[22] = crc & 0xff; page[23] = (crc >>> 8) & 0xff; page[24] = (crc >>> 16) & 0xff; page[25] = crc >>> 24;
    at += p.bytes.length;
  });
  return out;
}
