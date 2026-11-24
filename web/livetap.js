// livetap.js
// A second, silent copy of the live stream, decoded in the page, for the analysers. Safari on iPhone plays
// the radio's live Ogg stream out loud but hands createMediaElementSource nothing but zeros (tapes, which are
// files, are fine), so the picture had no sound to follow and the watchdog showed NO SIGNAL and reloaded
// the stream every 10 s. dsp.js starts a LiveTap next to the <audio> element; when the element turns out
// to be silent to the analysers while the tap hears music, the tap's PCM goes in instead, through the same
// feed worklet that embed mode uses. The <audio> element still plays what is heard, so the lock screen,
// background play, the volume and the EQ behave as before.
//
// Decoding: WebCodecs (AudioDecoder) where the browser has the codec, otherwise decodeAudioData on short
// Ogg files cut from the stream (the header pages, the last page of the previous cut to prime the decoder,
// then about half a second of pages). The output is kept with its position in seconds from the first
// sample, so dsp.js can hand it over as the <audio> element's playhead reaches it.
import { OggReader, PacketJoiner, FLAG_BOS, codecInfo, xiphLace, writeOgg } from './ogg.js';

const CUT_S = 0.5;        // decodeAudioData: seconds of stream per cut
const KEEP_S = 30;        // decoded audio kept ahead of the playhead, at most
const PEAK_BLOCK = 512;   // samples per RMS block for `peak` (the analysers' block)

export class LiveTap {
  /** `url`: the stream; `ctx`: an AudioContext (decodeAudioData's, and its rate). */
  constructor(url, ctx) {
    this.url = url;
    this.ctx = ctx;
    this.blocks = [];       // [{ t, pcm, rate, at }]: t is seconds from the first sample, at the first sample not yet taken
    this.t = 0;             // seconds decoded so far
    this.peak = 0;          // the loudest RMS block decoded so far
    this.failed = null;     // why the tap gave up, once it has
    this.ended = false;
    this.abort = null;
    this.decoder = null;
    this.reader = new OggReader();
    this.joiner = new PacketJoiner();
    this.stream = null;     // { serial, info, headers, headerPages } of the current logical stream
  }

  start() {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this.abort = ctl;
    const sep = this.url.includes('?') ? '&' : '?';
    fetch(`${this.url}${sep}tap=${Date.now()}`, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then((res) => {
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const body = res.body.getReader();
        const pump = () => body.read().then(({ done, value }) => {
          if (done || this.abort !== ctl) { this.ended = true; return undefined; }
          for (const page of this.reader.push(value)) this.page(page);
          return this.failed ? body.cancel() : pump();
        });
        return pump();
      })
      .catch((err) => {
        if (this.abort === ctl) this.fail(err);
      });
  }

  stop() {
    const ctl = this.abort;
    this.abort = null;
    if (ctl) ctl.abort();
    this.decoder?.close();
    this.decoder = null;
    this.blocks = [];
  }

  /**
   * Removes and returns the decoded audio before `t` seconds, as blocks of their own (safe to transfer); a
   * block that runs past `t` is cut there and its rest stays, so the feed worklet is handed a frame's worth
   * at a time, not a whole cut.
   */
  take(t) {
    const out = [];
    while (this.blocks.length && this.blocks[0].t < t) {
      const b = this.blocks[0];
      const n = Math.min(b.pcm.length - b.at, Math.ceil((t - b.t) * b.rate));
      out.push({ t: b.t, pcm: b.pcm.slice(b.at, b.at + n), rate: b.rate });
      b.at += n;
      b.t += n / b.rate;
      if (b.at >= b.pcm.length) this.blocks.shift();
      else break;
    }
    return out;
  }

  fail(err) {
    if (this.failed) return;
    this.failed = err && err.message ? err.message : String(err);
    console.warn('[livetap] stopped:', this.failed);
    this.decoder?.close();
    this.decoder = null;
  }

  page(p) {
    if (this.failed) return;
    if (p.flags & FLAG_BOS) {
      // A new logical stream (the start, or the source changed): new headers, a new decoder.
      this.decoder?.close();
      this.decoder = null;
      this.joiner.reset();
      this.stream = { serial: p.serial, info: null, headers: [], headerPages: [], waiting: null };
    }
    const s = this.stream;
    if (!s || p.serial !== s.serial) return; // joined mid-stream, or another stream multiplexed in
    const packets = this.joiner.page(p);
    if (!s.info || s.headers.length < s.info.headers) {
      s.headerPages.push(p);
      while (packets.length && (!s.info || s.headers.length < s.info.headers)) {
        s.headers.push(packets.shift().data);
        if (s.headers.length === 1) {
          s.info = codecInfo(s.headers[0]);
          if (!s.info) { this.fail(new Error('not a Vorbis or Opus stream')); return; }
        }
      }
      if (s.headers.length === s.info.headers) this.openDecoder(s);
      if (!packets.length) return;
    }
    if (s.waiting) s.waiting.push([p, packets]); // the decoder is still being chosen
    else this.decoder?.page(p, packets);
  }

  /** WebCodecs if it takes the codec, else decodeAudioData. Pages that come meanwhile wait, so none is lost. */
  openDecoder(s) {
    const onPcm = (pcm, rate) => this.add(pcm, rate);
    const toFiles = (err) => {
      // WebCodecs refused a packet: go on with decodeAudioData from the next cut.
      if (this.decoder instanceof CodecsDecoder) {
        this.decoder.close();
        this.decoder = new FileDecoder(this.ctx, s, onPcm, (e) => this.fail(e));
      } else this.fail(err);
    };
    s.waiting = [];
    CodecsDecoder.make(s, onPcm, toFiles).then((dec) => {
      if (this.stream !== s || this.failed) { dec?.close(); return; }
      this.decoder = dec || new FileDecoder(this.ctx, s, onPcm, (e) => this.fail(e));
      const waiting = s.waiting;
      s.waiting = null;
      for (const [p, packets] of waiting) this.decoder.page(p, packets);
    });
  }

  add(pcm, rate) {
    if (!pcm.length || this.failed) return;
    this.blocks.push({ t: this.t, pcm, rate, at: 0 });
    this.t += pcm.length / rate;
    for (let i = 0; i + PEAK_BLOCK <= pcm.length; i += PEAK_BLOCK) {
      let sum = 0;
      for (let k = i; k < i + PEAK_BLOCK; k++) sum += pcm[k] * pcm[k];
      const rms = Math.sqrt(sum / PEAK_BLOCK);
      if (rms > this.peak) this.peak = rms;
    }
    // Nobody is taking it (the page is in the background): keep the newest KEEP_S seconds.
    while (this.blocks.length > 1 && this.t - this.blocks[0].t > KEEP_S) this.blocks.shift();
  }
}

/** Mixes planar channels down to one Float32Array. */
function mixdown(channels) {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i];
  const g = 1 / channels.length;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

/** WebCodecs: packet by packet. `make` resolves null where the browser lacks it or the codec. */
class CodecsDecoder {
  static make(s, onPcm, onError) {
    if (typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined') return Promise.resolve(null);
    const { info, headers } = s;
    const config = {
      codec: info.codec,
      sampleRate: info.rate,
      numberOfChannels: info.channels,
      description: info.codec === 'vorbis' ? xiphLace(headers) : headers[0],
    };
    return AudioDecoder.isConfigSupported(config)
      .then((r) => (r && r.supported ? new CodecsDecoder(config, info, onPcm, onError) : null))
      .catch(() => null);
  }

  constructor(config, info, onPcm, onError) {
    this.rate = info.rate;
    this.us = 0;
    this.dec = new AudioDecoder({
      output: (data) => {
        try {
          const channels = [];
          for (let c = 0; c < data.numberOfChannels; c++) {
            const ch = new Float32Array(data.numberOfFrames);
            data.copyTo(ch, { planeIndex: c, format: 'f32-planar' });
            channels.push(ch);
          }
          onPcm(mixdown(channels), data.sampleRate);
        } finally {
          data.close();
        }
      },
      error: (err) => onError(err),
    });
    this.dec.configure(config);
  }

  page(p, packets) {
    if (this.dec.state !== 'configured') return;
    for (const pkt of packets) {
      if (pkt.granule >= 0) this.us = Math.round((pkt.granule / this.rate) * 1e6);
      this.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: this.us, data: pkt.data }));
    }
  }

  close() {
    if (this.dec.state !== 'closed') this.dec.close();
  }
}

/**
 * decodeAudioData: whole Ogg files cut from the stream. Each cut starts with the previous cut's last page,
 * which primes the decoder; of what comes out, only the cut's own length (from the granules) is kept, from
 * the end, so the cuts join without a gap or an overlap.
 */
class FileDecoder {
  constructor(ctx, s, onPcm, onError) {
    this.ctx = ctx;
    this.s = s;
    this.onPcm = onPcm;
    this.onError = onError;
    this.pending = [];
    this.prevPage = null;
    this.prevEnd = -1;    // granule at the end of the previous cut
    this.chain = Promise.resolve();
    this.closed = false;
    this.decoded = 0;     // cuts decoded
  }

  page(p) {
    this.pending.push(p);
    if (p.granule < 0) return;
    const from = this.prevEnd >= 0 ? this.prevEnd : this.pending.find((q) => q.granule >= 0).granule;
    if (this.pending.length > 1 && (p.granule - from) / this.s.info.rate < CUT_S) return;
    const pages = this.pending;
    this.pending = [];
    const file = writeOgg([...this.s.headerPages, ...(this.prevPage ? [this.prevPage] : []), ...pages]);
    const want = this.prevEnd >= 0 ? ((p.granule - this.prevEnd) / this.s.info.rate) * this.ctx.sampleRate : Infinity;
    this.prevEnd = p.granule;
    this.prevPage = pages[pages.length - 1];
    this.chain = this.chain
      .then(() => (this.closed ? null : this.ctx.decodeAudioData(file.buffer)))
      .then((buf) => {
        if (!buf || this.closed) return;
        this.decoded++;
        const channels = [];
        for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
        let pcm = mixdown(channels);
        const keep = Math.min(pcm.length, Math.round(want));
        if (keep < pcm.length) pcm = pcm.slice(pcm.length - keep);
        this.onPcm(pcm, buf.sampleRate);
      })
      .catch((err) => {
        // One bad cut is skipped; a decoder that never manages one is no decoder.
        if (!this.closed && this.decoded === 0) this.onError(err || new Error('decodeAudioData failed'));
      });
  }

  close() {
    this.closed = true;
    this.pending = [];
  }
}
