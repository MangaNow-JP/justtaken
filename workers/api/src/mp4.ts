import type { CaptureManifest } from '@justtaken/contracts';
type Asset = CaptureManifest['assets'][number];
function check(ok: unknown, message = 'Invalid MP4'): asserts ok {
  if (!ok) throw new Error(message);
}
const u32 = (b: Uint8Array, p: number) => {
  check(p >= 0 && p + 4 <= b.length);
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(p);
};
const tag = (b: Uint8Array, p: number) => String.fromCharCode(...b.subarray(p, p + 4));
interface Box {
  type: string;
  data: Uint8Array;
}
function boxes(b: Uint8Array): Box[] {
  const result: Box[] = [];
  for (let p = 0; p < b.length;) {
    check(p + 8 <= b.length && result.length < 4096);
    const size = u32(b, p);
    check(size >= 8 && p + size <= b.length);
    result.push({ type: tag(b, p + 4), data: b.subarray(p + 8, p + size) });
    p += size;
  }
  return result;
}
function children(b: Uint8Array, allowed: string[]) {
  const result = boxes(b);
  check(
    result.every((x) => allowed.includes(x.type)),
    'Unexpected MP4 metadata or track',
  );
  return result;
}
function one(b: Box[], type: string) {
  const found = b.filter((x) => x.type === type);
  check(found.length === 1, 'Missing or duplicate ' + type);
  return found[0].data;
}
function duration(b: Uint8Array) {
  check(b[0] === 0 || b[0] === 1);
  const p = b[0] === 1 ? 20 : 12;
  const scale = u32(b, p);
  check(scale > 0);
  if (b[0] === 1) check(u32(b, p + 4) === 0);
  const ticks = u32(b, p + (b[0] === 1 ? 8 : 4));
  check(ticks > 0);
  return { scale, ticks, ms: (ticks / scale) * 1000 };
}
class Bits {
  pos = 0;
  constructor(private bytes: Uint8Array) {}
  n(n: number): number {
    check(n <= 32 && this.pos + n <= this.bytes.length * 8);
    let v = 0;
    while (n--) {
      v = v * 2 + ((this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  ue() {
    let n = 0;
    while (this.n(1) === 0) {
      check(++n < 24);
    }
    return 2 ** n - 1 + this.n(n);
  }
  se() {
    const n = this.ue();
    return n % 2 ? (n + 1) / 2 : -n / 2;
  }
}
function sps(data: Uint8Array, width: number, height: number) {
  check((data[0] & 31) === 7);
  const bytes: number[] = [];
  for (let i = 1; i < data.length; i++) {
    if (i >= 3 && data[i] === 3 && data[i - 1] === 0 && data[i - 2] === 0) continue;
    bytes.push(data[i]);
  }
  const b = new Bits(Uint8Array.from(bytes)),
    profile = b.n(8);
  b.n(8);
  const level = b.n(8);
  b.ue();
  check([66, 77, 100].includes(profile) && level <= 52, 'Unsupported H264 profile');
  if (profile === 100) {
    check(b.ue() === 1 && b.ue() === 0 && b.ue() === 0, 'Only SDR 8-bit 4:2:0');
    b.n(1);
    if (b.n(1))
      for (let i = 0; i < 8; i++)
        if (b.n(1)) {
          let last = 8,
            next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next) next = (last + b.se() + 256) % 256;
            last = next || last;
          }
        }
  }
  b.ue();
  const poc = b.ue();
  check(poc <= 2);
  if (poc === 0) b.ue();
  else if (poc === 1) {
    b.n(1);
    b.se();
    b.se();
    const count = b.ue();
    check(count < 256);
    for (let i = 0; i < count; i++) b.se();
  }
  b.ue();
  b.n(1);
  const w = (b.ue() + 1) * 16,
    h = (b.ue() + 1) * 16;
  check(b.n(1) === 1, 'Interlaced video');
  b.n(1);
  let left = 0,
    right = 0,
    top = 0,
    bottom = 0;
  if (b.n(1)) {
    left = b.ue();
    right = b.ue();
    top = b.ue();
    bottom = b.ue();
  }
  check(w - 2 * (left + right) === width && h - 2 * (top + bottom) === height, 'SPS dimensions');
  if (b.n(1)) {
    if (b.n(1)) {
      if (b.n(8) === 255) {
        b.n(16);
        b.n(16);
      }
    }
    if (b.n(1)) b.n(1);
    if (b.n(1)) {
      b.n(3);
      b.n(1);
      if (b.n(1)) {
        const primaries = b.n(8),
          transfer = b.n(8),
          matrix = b.n(8);
        check(
          ![9, 10].includes(primaries) && ![16, 18].includes(transfer) && ![9, 10].includes(matrix),
          'HDR video',
        );
      }
    }
  }
}
function avcc(b: Uint8Array, width: number, height: number) {
  check(b.length >= 7 && b[0] === 1 && (b[4] & 3) === 3);
  let p = 6;
  const count = b[5] & 31;
  check(count > 0 && count <= 8);
  for (let i = 0; i < count; i++) {
    check(p + 2 <= b.length);
    const size = b[p] * 256 + b[p + 1];
    p += 2;
    check(size > 0 && p + size <= b.length);
    sps(b.subarray(p, p + size), width, height);
    p += size;
  }
  check(p < b.length);
  const pps = b[p++];
  check(pps > 0 && pps <= 8);
  for (let i = 0; i < pps; i++) {
    const size = b[p] * 256 + b[p + 1];
    p += 2;
    check(size > 0 && p + size <= b.length && (b[p] & 31) === 8);
    p += size;
  }
  // High profile avcC may carry the four optional chroma/bit-depth fields.
  if (p < b.length) {
    check(
      b[1] === 100 &&
        p + 4 === b.length &&
        (b[p] & 3) === 1 &&
        (b[p + 1] & 7) === 0 &&
        (b[p + 2] & 7) === 0 &&
        b[p + 3] === 0,
    );
  }
}
function hvcc(b: Uint8Array, width: number, height: number) {
  check(
    b.length >= 23 && b[0] === 1 && (b[21] & 3) === 3 && [1, 2].includes(b[1] & 31),
    'Unsupported HEVC profile',
  );
  const depth = 8 + (b[17] & 7);
  check(
    [8, 10].includes(depth) && 8 + (b[18] & 7) === depth && (b[16] & 3) === 1,
    'HEVC bit depth/chroma',
  );
  let p = 23;
  const found = new Set<number>();
  for (let i = 0; i < b[22]; i++) {
    check(p + 3 <= b.length);
    const type = b[p++] & 63,
      count = b[p++] * 256 + b[p++];
    check([32, 33, 34, 39, 40].includes(type) && count > 0 && count <= 64);
    found.add(type);
    for (let n = 0; n < count; n++) {
      check(p + 2 <= b.length);
      const size = b[p++] * 256 + b[p++];
      check(size >= 3 && p + size <= b.length);
      const nal = b.subarray(p, p + size);
      p += size;
      check(((nal[0] >> 1) & 63) === type);
      if (type !== 33) continue;
      const raw: number[] = [];
      for (let j = 2; j < nal.length; j++) {
        if (j >= 4 && nal[j] === 3 && nal[j - 1] === 0 && nal[j - 2] === 0) continue;
        raw.push(nal[j]);
      }
      const bits = new Bits(Uint8Array.from(raw));
      bits.n(4);
      const layers = bits.n(3);
      bits.n(1);
      bits.n(32);
      bits.n(32);
      bits.n(32);
      const flags = Array.from({ length: layers }, () => [bits.n(1), bits.n(1)]);
      if (layers) for (let j = layers; j < 8; j++) bits.n(2);
      for (const [profile, level] of flags) {
        if (profile) {
          bits.n(32);
          bits.n(32);
          bits.n(24);
        }
        if (level) bits.n(8);
      }
      bits.ue();
      check(bits.ue() === 1, 'HEVC chroma');
      const w = bits.ue(),
        h = bits.ue();
      let left = 0,
        right = 0,
        top = 0,
        bottom = 0;
      if (bits.n(1)) {
        left = bits.ue();
        right = bits.ue();
        top = bits.ue();
        bottom = bits.ue();
      }
      check(
        w - 2 * (left + right) === width && h - 2 * (top + bottom) === height,
        'HEVC SPS dimensions',
      );
      check(bits.ue() + 8 === depth && bits.ue() + 8 === depth, 'HEVC SPS bit depth');
    }
  }
  check(p === b.length && [32, 33, 34].every((type) => found.has(type)), 'HEVC parameter sets');
  return depth;
}
function rotation(header: Uint8Array) {
  check(header[0] === 0 || header[0] === 1);
  const p = header[0] === 1 ? 52 : 40;
  const signed = (at: number) =>
    new DataView(header.buffer, header.byteOffset, header.byteLength).getInt32(at);
  check(
    header.length >= p + 44 &&
      signed(p + 8) === 0 &&
      signed(p + 20) === 0 &&
      u32(header, p + 32) === 0x40000000,
    'Video matrix',
  );
  const a = signed(p),
    b = signed(p + 4),
    c = signed(p + 12),
    d = signed(p + 16),
    unit = 65536;
  for (const [angle, values] of [
    [0, [unit, 0, 0, unit]],
    [90, [0, unit, -unit, 0]],
    [180, [-unit, 0, 0, -unit]],
    [270, [0, -unit, unit, 0]],
  ] as const)
    if ([a, b, c, d].every((v, i) => v === values[i])) return angle;
  throw new Error('Unsupported video transform');
}
function aac(b: Uint8Array) {
  function descriptor(data: Uint8Array, at: number) {
    check(at < data.length);
    const type = data[at++];
    let size = 0,
      done = false;
    for (let i = 0; i < 4; i++) {
      check(at < data.length);
      const v = data[at++];
      size = size * 128 + (v & 127);
      if (!(v & 128)) {
        done = true;
        break;
      }
    }
    check(done && at + size <= data.length);
    return { type, data: data.subarray(at, at + size), end: at + size };
  }
  const es = descriptor(b, 4);
  check(es.type === 3 && es.data.length >= 3 && es.data[2] === 0);
  const decoder = descriptor(es.data, 3);
  check(decoder.type === 4 && decoder.data[0] === 0x40 && decoder.data[1] >> 2 === 5);
  const specific = descriptor(decoder.data, 13);
  check(specific.type === 5);
  const bits = new Bits(specific.data);
  check(bits.n(5) === 2, 'AAC-LC required');
  const frequency = bits.n(4);
  check(frequency <= 12);
  const channels = bits.n(4);
  check(channels === 1 || channels === 2);
  check(bits.n(1) === 0 && bits.n(1) === 0 && bits.n(1) === 0, 'Unsupported AAC config');
  // AAC-LC encoders may explicitly signal that SBR/PS is absent. Never accept HE-AAC.
  if (specific.data.length * 8 - bits.pos >= 17) {
    const extension = bits.n(11);
    if (extension !== 0) {
      check(extension === 0x2b7 && bits.n(5) === 5 && bits.n(1) === 0, 'SBR is not AAC-LC');
      if (specific.data.length * 8 - bits.pos >= 12) {
        const ps = bits.n(11);
        check(ps === 0 || (ps === 0x548 && bits.n(1) === 0), 'PS is not AAC-LC');
      }
    }
  }
  while (bits.pos < specific.data.length * 8) check(bits.n(1) === 0);
}
interface Track {
  kind: string;
  ranges: { offset: number; size: number }[];
}
function track(data: Uint8Array, asset: Asset): Track {
  const t = children(data, ['tkhd', 'edts', 'mdia']);
  const tkhd = one(t, 'tkhd');
  for (const edit of t.filter((x) => x.type === 'edts')) {
    const e = one(children(edit.data, ['elst']), 'elst');
    check(e[0] <= 1 && u32(e, 4) <= 2);
  }
  const mdia = children(one(t, 'mdia'), ['mdhd', 'hdlr', 'minf']),
    time = duration(one(mdia, 'mdhd'));
  const handler = one(mdia, 'hdlr'),
    kind = tag(handler, 8);
  check(['vide', 'soun'].includes(kind));
  check(time.ms <= 60_000 && time.ms > 0, 'Track duration');
  const minf = children(one(mdia, 'minf'), ['vmhd', 'smhd', 'dinf', 'stbl']);
  const dref = one(children(one(minf, 'dinf'), ['dref']), 'dref');
  check(u32(dref, 4) === 1);
  const reference = boxes(dref.subarray(8));
  check(
    reference.length === 1 &&
      reference[0].type === 'url ' &&
      reference[0].data.length === 4 &&
      u32(reference[0].data, 0) === 1,
    'External data reference',
  );
  const stbl = children(one(minf, 'stbl'), [
    'stsd',
    'stts',
    'stsc',
    'stsz',
    'stco',
    'co64',
    'ctts',
    'stss',
    'sdtp',
    'sgpd',
    'sbgp',
  ]);
  const sd = one(stbl, 'stsd');
  check(u32(sd, 4) === 1);
  const entries = boxes(sd.subarray(8));
  check(entries.length === 1);
  const entry = entries[0],
    e = entry.data;
  check(e.length >= 8 && e[6] === 0 && e[7] === 1);
  if (kind === 'vide') {
    const hevc = ['hvc1', 'hev1'].includes(entry.type);
    check(
      (asset.videoCodec === 'hevc' ? hevc : entry.type === 'avc1') && e.length >= 78,
      'Video codec mismatch',
    );
    if (asset.rotationDegrees !== undefined)
      check(rotation(tkhd) === asset.rotationDegrees, 'Video rotation mismatch');
    const width = e[24] * 256 + e[25],
      height = e[26] * 256 + e[27];
    check(width === asset.width && height === asset.height, 'Video dimensions');
    const extra = children(e.subarray(78), [
      'avcC',
      'hvcC',
      'mdcv',
      'clli',
      'dvvC',
      'amve',
      'pasp',
      'colr',
      'btrt',
      'clap',
      'fiel',
      'chrm',
    ]);
    const depth = hevc
      ? hvcc(one(extra, 'hvcC'), width, height)
      : (avcc(one(extra, 'avcC'), width, height), 8);
    check(depth === (asset.videoBitDepth ?? 8), 'Video bit depth mismatch');
    const colors = extra.filter((x) => x.type === 'colr');
    check(colors.length <= 1);
    let transfer = 'sdr';
    for (const color of colors) {
      check(['nclx', 'nclc'].includes(tag(color.data, 0)) && color.data.length >= 10);
      const code = color.data[6] * 256 + color.data[7];
      transfer = code === 16 ? 'pq' : code === 18 ? 'hlg' : 'sdr';
    }
    check(
      transfer === (asset.colorTransfer ?? 'sdr') && (transfer === 'sdr' || depth === 10),
      'Video color transfer mismatch',
    );
    for (const [type, length] of [
      ['mdcv', 24],
      ['clli', 4],
      ['amve', 8],
    ] as const) {
      const records = extra.filter((x) => x.type === type);
      check(
        records.length <= 1 && records.every((x) => x.data.length === length),
        'HDR metadata size',
      );
    }
    // Apple camera Dolby Vision 8.4: one HEVC Main10 HLG layer plus RPU, no enhancement layer.
    const dolby = extra.filter((x) => x.type === 'dvvC');
    check(dolby.length <= 1);
    for (const { data: b } of dolby)
      check(
        hevc &&
          depth === 10 &&
          transfer === 'hlg' &&
          b.length === 24 &&
          b[0] === 1 &&
          b[1] === 0 &&
          b[2] >> 1 === 8 &&
          (b[3] & 7) === 5 &&
          b[4] === 64 &&
          b.subarray(5).every((v) => v === 0),
        'Unsupported Dolby Vision configuration',
      );
  } else {
    check(entry.type === 'mp4a' && e.length >= 28 && e[8] === 0 && e[9] === 0, 'AAC required');
    aac(one(children(e.subarray(28), ['esds', 'btrt']), 'esds'));
  }
  const sizes = one(stbl, 'stsz'),
    constant = u32(sizes, 4),
    count = u32(sizes, 8);
  check(count > 0 && count <= 4096 && sizes.length === 12 + (constant ? 0 : count * 4));
  const sampleSizes = Array.from({ length: count }, (_, i) => constant || u32(sizes, 12 + 4 * i));
  check(sampleSizes.every((n) => n > 0 && n <= asset.bytes));
  const times = one(stbl, 'stts'),
    timeCount = u32(times, 4);
  check(timeCount > 0 && times.length === 8 + timeCount * 8);
  let samples = 0,
    ticks = 0;
  for (let i = 0; i < timeCount; i++) {
    const n = u32(times, 8 + i * 8),
      delta = u32(times, 12 + i * 8);
    check(n > 0 && delta > 0);
    samples += n;
    ticks += n * delta;
    if (kind === 'vide') check(delta + 1 >= time.scale / 60, 'Video frame rate');
  }
  check(samples === count && ticks === time.ticks, 'Sample timing mismatch');
  if (kind === 'vide') {
    const fps = asset.fpsNumerator! / asset.fpsDenominator!;
    check(fps > 0 && fps <= 60 && (count * time.scale) / ticks <= fps + 0.1, 'Manifest frame rate');
  }
  const sc = one(stbl, 'stsc'),
    groups = u32(sc, 4);
  check(groups > 0 && sc.length === 8 + groups * 12);
  const offsetBoxes = stbl.filter((x) => ['stco', 'co64'].includes(x.type));
  check(offsetBoxes.length === 1);
  const ob = offsetBoxes[0],
    offsets = ob.data,
    chunks = u32(offsets, 4),
    stride = ob.type === 'co64' ? 8 : 4;
  check(chunks > 0 && chunks <= 4096 && offsets.length === 8 + chunks * stride);
  const groupsData = Array.from({ length: groups }, (_, i) => {
    const first = u32(sc, 8 + i * 12),
      per = u32(sc, 12 + i * 12);
    check(first > 0 && first <= chunks && per > 0 && u32(sc, 16 + i * 12) === 1);
    return { first, per };
  });
  check(
    groupsData[0].first === 1 &&
      groupsData.every((g, i) => i === 0 || g.first > groupsData[i - 1].first),
  );
  let sample = 0,
    group = 0;
  const ranges: Track['ranges'] = [];
  for (let i = 0; i < chunks; i++) {
    if (group + 1 < groups && i + 1 === groupsData[group + 1].first) group++;
    if (stride === 8) check(u32(offsets, 8 + i * stride) === 0);
    const offset = u32(offsets, 8 + i * stride + stride - 4),
      end = sample + groupsData[group].per;
    check(end <= count);
    let size = 0;
    while (sample < end) size += sampleSizes[sample++];
    ranges.push({ offset, size });
  }
  check(sample === count);
  return { kind, ranges };
}
// Buffer only bounded container headers (<=512 KiB), never video/audio payloads.
export class MP4Inspector {
  private pending = new Uint8Array(0);
  private remaining = 0;
  private payload: Uint8Array | null = null;
  private written = 0;
  private current = '';
  private offset = 0;
  private seen = new Set<string>();
  private ranges: Track['ranges'] = [];
  private mdat: { start: number; end: number } | null = null;
  constructor(private asset: Asset) {}
  push(input: Uint8Array) {
    let p = 0;
    while (p < input.length) {
      if (!this.remaining) {
        const n = Math.min(
            (this.pending.length >= 8 ? 16 : 8) - this.pending.length,
            input.length - p,
          ),
          header = new Uint8Array(this.pending.length + n);
        header.set(this.pending);
        header.set(input.subarray(p, p + n), this.pending.length);
        this.pending = header;
        p += n;
        this.offset += n;
        if (header.length < 8) continue;
        const extended = u32(header, 0) === 1;
        if (extended && header.length < 16) continue;
        const headerSize = extended ? 16 : 8;
        if (extended) check(u32(header, 8) === 0);
        const size = u32(header, extended ? 12 : 0),
          type = tag(header, 4);
        check(
          size >= headerSize &&
            size <= this.asset.bytes &&
            this.offset - headerSize + size <= this.asset.bytes,
        );
        check(['ftyp', 'moov', 'mdat', 'free', 'wide'].includes(type));
        if (!this.seen.size) check(type === 'ftyp');
        if (!['free', 'wide'].includes(type)) {
          check(!this.seen.has(type));
          this.seen.add(type);
        }
        if (type === 'moov') check(size <= 524288 && !this.seen.has('mdat'));
        if (type === 'ftyp') check(size <= 1024);
        if (type === 'mdat') {
          check(this.seen.has('moov'));
          this.mdat = { start: this.offset, end: this.offset - headerSize + size };
        }
        this.current = type;
        this.remaining = size - headerSize;
        this.written = 0;
        this.payload = ['ftyp', 'moov'].includes(type) ? new Uint8Array(this.remaining) : null;
        this.pending = new Uint8Array(0);
        if (!this.remaining) this.endBox();
      } else {
        const n = Math.min(this.remaining, input.length - p);
        this.payload?.set(input.subarray(p, p + n), this.written);
        this.written += n;
        p += n;
        this.offset += n;
        this.remaining -= n;
        if (!this.remaining) this.endBox();
      }
    }
  }
  private endBox() {
    if (this.current === 'ftyp')
      check(
        this.payload &&
          this.payload.length >= 8 &&
          ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '].includes(tag(this.payload, 0)),
        'MP4 brand',
      );
    if (this.current === 'moov') {
      const moov = children(this.payload!, ['mvhd', 'trak', 'iods']),
        time = duration(one(moov, 'mvhd'));
      check(
        time.ms <= 60_000 && Math.abs(time.ms - this.asset.durationMs!) <= 1,
        'Manifest duration',
      );
      const tracks = moov.filter((x) => x.type === 'trak');
      check(tracks.length >= 1 && tracks.length <= 2);
      const parsed = tracks.map((x) => track(x.data, this.asset));
      check(
        parsed.filter((x) => x.kind === 'vide').length === 1 &&
          parsed.filter((x) => x.kind === 'soun').length === (this.asset.audioCodec ? 1 : 0),
        'Audio track mismatch',
      );
      this.ranges = parsed.flatMap((t) => t.ranges).sort((a, b) => a.offset - b.offset);
    }
    this.payload = null;
  }
  finish() {
    check(
      this.remaining === 0 &&
        this.pending.length === 0 &&
        this.offset === this.asset.bytes &&
        this.seen.has('ftyp') &&
        this.seen.has('moov') &&
        this.mdat,
      'Incomplete MP4',
    );
    let end = this.mdat.start;
    for (const range of this.ranges) {
      check(
        range.offset >= end && range.offset + range.size <= this.mdat.end,
        'Sample outside mdat or overlap',
      );
      end = range.offset + range.size;
    }
    check(this.ranges.length > 0);
  }
}
