// png-squeeze-01 entry: squeeze 1280x720 screenshots into the smallest lossless PNG.
// Strategy (V4): for each image, screen every candidate colour form + filter
// choice at zlib level 6, keep the best, then re-compress its filtered bytes with
// the best of four zlib level-9 variants (plain, memLevel 8 + filtered strategy,
// and two SYNC_FLUSH split streams at 128 KiB / 256 KiB). Deterministic: no clock,
// no randomness, no network; the work budget is the candidate list, not time.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync, deflateSync, createDeflate, constants } from 'node:zlib';

const INPUT_DIR: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------- CRC32 / PNG container ----------

const PNG_SIG: Uint8Array = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

const CRC_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
}

type Chunk = [string, Uint8Array];

function pngOf(chunks: Chunk[]): Uint8Array {
  let size = PNG_SIG.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(PNG_SIG, 0);
  let at = PNG_SIG.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8; // bit depth
  d[9] = colourType;
  return d;
}

// ---------- PNG decode (8-bit, non-interlaced, colour types 0/2/3/4/6) ----------

interface Decoded {
  rgba: Uint8Array;
  width: number;
  height: number;
}

function decodePng(bytes: Uint8Array): Decoded {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || PNG_SIG.some((b, i) => bytes[i] !== b)) throw new Error('bad signature');
  let at = 8;
  let header: { width: number; height: number; colourType: number } | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (header === null) throw new Error('no IHDR');
  const ch: number = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[header.colourType];
  const total = idat.reduce((s, d) => s + d.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const d of idat) { joined.set(d, off); off += d.length; }
  const raw = inflateSync(joined);
  const w = header.width;
  const h = header.height;
  const stride = w * ch;
  const rgba = new Uint8Array(w * h * 4);
  const prev = new Uint8Array(stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    const row = raw.subarray(rp, rp + stride);
    rp += stride;
    const bpp = ch === 1 ? 1 : ch;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v: number;
      if (f === 0) v = row[i];
      else if (f === 1) v = row[i] + a;
      else if (f === 2) v = row[i] + b;
      else if (f === 3) v = row[i] + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      prev[i] = v & 0xff;
    }
    const out = rgba.subarray(y * w * 4, (y + 1) * w * 4);
    if (header.colourType === 6) out.set(prev);
    else if (header.colourType === 2) {
      for (let i = 0, o = 0; i < stride; i += 3, o += 4) {
        out[o] = prev[i]; out[o + 1] = prev[i + 1]; out[o + 2] = prev[i + 2]; out[o + 3] = 255;
      }
    } else if (header.colourType === 0) {
      for (let i = 0, o = 0; i < stride; i++, o += 4) {
        out[o] = out[o + 1] = out[o + 2] = prev[i]; out[o + 3] = 255;
      }
    } else if (header.colourType === 4) {
      for (let i = 0, o = 0; i < stride; i += 2, o += 4) {
        out[o] = out[o + 1] = out[o + 2] = prev[i]; out[o + 3] = prev[i + 1];
      }
    } else if (header.colourType === 3) {
      for (let i = 0, o = 0; i < stride; i++, o += 4) {
        const idx = prev[i] * 3;
        out[o] = (palette as Uint8Array)[idx];
        out[o + 1] = (palette as Uint8Array)[idx + 1];
        out[o + 2] = (palette as Uint8Array)[idx + 2];
        out[o + 3] = trns && idx / 3 < trns.length ? trns[idx / 3] : 255;
      }
    }
  }
  return { rgba, width: w, height: h };
}

// ---------- PNG filters ----------

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
    return;
  }
  if (type === 2) {
    if (prev === null) { out.set(cur); return; }
    for (let i = 0; i < n; i++) out[i] = cur[i] - prev[i];
    return;
  }
  if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      out[i] = cur[i] - ((a + b) >> 1);
    }
    return;
  }
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev === null ? 0 : prev[i];
    const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
    out[i] = cur[i] - paeth(a, b, c);
  }
}

/** Sum of |signed byte| over a row: a cheap proxy for compressibility. */
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// ---------- Image analysis / candidate forms ----------

interface Colour {
  rgba: number[];
  word: number;
  count: number;
}

interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: Colour[] | null;
}

function wordsOf(rgba: Uint8Array): Uint32Array {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

function analyse(rgba: Uint8Array): Analysis {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) as number };
  });
  return { opaque, grey, colours };
}

/** A single transparent colour usable as a tRNS key, or null. */
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

const lumOf = (c: Colour): number => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];

function paletteOrder(colours: Colour[], order: string): Colour[] {
  const transparentFirst = (x: Colour, y: Colour): number => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    return 0;
  };
  if (order === 'count') {
    return [...colours].sort((x, y) => transparentFirst(x, y) || y.count - x.count || x.word - y.word);
  }
  // 'luminance'
  return [...colours].sort((x, y) => transparentFirst(x, y) || lumOf(x) - lumOf(y) || x.word - y.word);
}

interface Palette {
  plte: Uint8Array;
  trns: Uint8Array | null;
  indices: Uint8Array;
}

function paletteForm(rgba: Uint8Array, colours: Colour[], order: string): Palette {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]) as number;
  return { plte, trns, indices };
}

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  order: string | null;
  kind: string;
}

function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, order, kind: 'palette' });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, order: null, kind: 'channels' });
  return forms;
}

// ---------- Filtering ----------

const SCREEN = Object.freeze({ level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY });
const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

type FilterChoice = number | 'minsum' | 'pairs' | 'brute';

/** Filter `samples` by `choice`. Returns the raw filtered bytes (filter byte + row, per row). */
function filtered(samples: Uint8Array, width: number, height: number, bpp: number, choice: FilterChoice): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      let cost: number;
      if (choice === 'minsum') cost = signedSum(trial[t]);
      else if (choice === 'pairs') {
        let n = 0;
        const row = trial[t];
        stamp++;
        for (let i = 1; i < row.length; i++) {
          const pair = (row[i - 1] << 8) | row[i];
          if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
        }
        cost = n;
      } else {
        // 'brute': actually compress this row (with the previous output as dictionary).
        cost = deflateSync(trial[t], before.length === 0
          ? { level: BRUTE_LEVEL, memLevel: 9 }
          : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) { best = cost; type = t; }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}

function pngOfForm(width: number, height: number, form: Form, idat: Uint8Array): Uint8Array {
  const chunks: Chunk[] = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

const chunkBytes = (form: Form): number =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// ---------- Deflate variants (final) ----------

/** One zlib stream with a SYNC_FLUSH every `chunkSize` input bytes: resetting the
 *  match window at fixed offsets usually beats a single stream on these images. */
function deflateSplit(data: Uint8Array, chunkSize: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const d = createDeflate({ level: 9 });
    const out: Buffer[] = [];
    d.on('data', (c: Buffer) => out.push(c));
    d.on('error', reject);
    d.on('end', () => resolve(Buffer.concat(out)));
    let i = 0;
    const step = (): void => {
      if (i >= data.length) { d.end(); return; }
      const end = Math.min(data.length, i + chunkSize);
      d.write(data.subarray(i, end), () => {
        if (end < data.length) d.flush(constants.Z_SYNC_FLUSH, () => { i = end; step(); });
        else { i = end; step(); }
      });
    };
    step();
  });
}

async function bestFinal(data: Uint8Array, form: Form): Promise<Buffer> {
  const cb = chunkBytes(form);
  const plain = deflateSync(data, { level: 9 });
  let best: Buffer = plain;
  let bestSize = plain.length + cb;
  const m8flt = deflateSync(data, { level: 9, memLevel: 8, strategy: constants.Z_FILTERED });
  if (m8flt.length + cb < bestSize) { best = m8flt; bestSize = m8flt.length + cb; }
  const sp128 = await deflateSplit(data, 131072);
  if (sp128.length + cb < bestSize) { best = sp128; bestSize = sp128.length + cb; }
  const sp256 = await deflateSplit(data, 262144);
  if (sp256.length + cb < bestSize) { best = sp256; bestSize = sp256.length + cb; }
  return best;
}

// ---------- Main ----------

function filterChoices(form: Form): FilterChoice[] {
  if (form.kind === 'palette') return form.order === 'count' ? [0] : [0, 'minsum', 'brute'];
  return [0, 1, 2, 3, 4, 'minsum', 'pairs', 'brute'];
}

async function compressOne(id: string): Promise<void> {
  const { rgba, width, height } = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  const forms = formsOf(rgba);
  let bestForm: Form | null = null;
  let bestData: Uint8Array | null = null;
  let bestSize = Infinity;
  for (const form of forms) {
    for (const choice of filterChoices(form)) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const size = deflateSync(data, SCREEN).length + chunkBytes(form);
      if (size < bestSize) { bestSize = size; bestForm = form; bestData = data; }
    }
  }
  if (bestForm === null || bestData === null) throw new Error('no candidate for ' + id);
  const idat = await bestFinal(bestData, bestForm);
  const png = pngOfForm(width, height, bestForm, idat);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
}

async function main(): Promise<void> {
  // Only directories that actually hold an image are instances; a stray file
  // in /input must not abort the run. One bad instance must not zero the
  // other seven, so each is attempted independently.
  const ids = readdirSync(INPUT_DIR).sort().filter((id) => {
    const dir = join(INPUT_DIR, id);
    try {
      return statSync(dir).isDirectory() && existsSync(join(dir, 'image.png'));
    } catch {
      return false;
    }
  });
  for (const id of ids) {
    try {
      await compressOne(id);
    } catch (e) {
      console.error(`instance ${id} failed:`, e instanceof Error ? e.message : e);
    }
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
