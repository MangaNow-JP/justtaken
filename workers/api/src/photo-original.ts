import type { CaptureManifest } from '@justtaken/contracts';
type Asset = CaptureManifest['assets'][number];
export interface PhotoReader {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}
function check(value: unknown, message = 'Invalid original photo'): asserts value {
  if (!value) throw new Error(message);
}
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const u16 = (b: Uint8Array, o = 0, le = false) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(o, le);
const u32 = (b: Uint8Array, o = 0, le = false) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, le);
export function memoryPhotoReader(bytes: Uint8Array): PhotoReader {
  return {
    size: bytes.length,
    async read(offset, length) {
      check(
        Number.isSafeInteger(offset) &&
          Number.isSafeInteger(length) &&
          offset >= 0 &&
          length >= 0 &&
          offset + length <= bytes.length,
      );
      return bytes.subarray(offset, offset + length);
    },
  };
}
export function r2PhotoReader(bucket: R2Bucket, key: string, size: number): PhotoReader {
  const pages = new Map<number, Uint8Array>();
  let requests = 0;
  return {
    size,
    async read(offset, length) {
      check(
        Number.isSafeInteger(offset) &&
          Number.isSafeInteger(length) &&
          offset >= 0 &&
          length >= 0 &&
          offset + length <= size &&
          length <= 4_194_304,
      );
      const output = new Uint8Array(length);
      for (let p = offset; p < offset + length;) {
        const page = Math.floor(p / 65536) * 65536;
        let data = pages.get(page);
        if (!data) {
          check(++requests <= 256, 'Photo metadata read budget exceeded');
          const object = await bucket.get(key, {
            range: { offset: page, length: Math.min(65536, size - page) },
          });
          check(object);
          data = new Uint8Array(await object.arrayBuffer());
          check(data.length === Math.min(65536, size - page));
          if (pages.size >= 16) pages.delete(pages.keys().next().value!);
          pages.set(page, data);
        }
        const count = Math.min(data.length - (p - page), offset + length - p);
        output.set(data.subarray(p - page, p - page + count), p - offset);
        p += count;
      }
      return output;
    },
  };
}
function checkXMP(bytes: Uint8Array) {
  const value = text(bytes);
  check(
    !/GPS(Latitude|Longitude|Altitude|Dest|Position|TimeStamp)|<!DOCTYPE|<!ENTITY/i.test(value),
    'Location metadata is not allowed',
  );
  return value;
}
interface TIFFEntry {
  type: number;
  count: number;
  offset: number;
  size: number;
}
interface TIFFDirectory {
  entries: Map<number, TIFFEntry>;
  values(tag: number): Promise<number[]>;
  bytes(tag: number): Promise<Uint8Array>;
}
// Bounded classic TIFF reader. Includes SubIFDs/Exif/Interop; opaque maker/calibration
// payloads are range-checked and retained, never rewritten or interpreted as code.
async function tiff(reader: PhotoReader): Promise<TIFFDirectory[]> {
  const head = await reader.read(0, 8),
    le = text(head.subarray(0, 2)) === 'II';
  check((le || text(head.subarray(0, 2)) === 'MM') && u16(head, 2, le) === 42, 'Invalid TIFF');
  const sizes: Record<number, number> = {
    1: 1,
    2: 1,
    3: 2,
    4: 4,
    5: 8,
    6: 1,
    7: 1,
    8: 2,
    9: 4,
    10: 8,
    11: 4,
    12: 8,
    13: 4,
  };
  const pending = [u32(head, 4, le)],
    seen = new Set<number>(),
    result: TIFFDirectory[] = [];
  while (pending.length) {
    const offset = pending.shift()!;
    if (!offset) continue;
    check(!seen.has(offset) && seen.size < 64 && offset >= 8, 'Cyclic TIFF');
    seen.add(offset);
    const count = u16(await reader.read(offset, 2), 0, le);
    check(count <= 4096);
    const data = await reader.read(offset + 2, count * 12 + 4),
      entries = new Map<number, TIFFEntry>();
    for (let i = 0; i < count; i++) {
      const p = i * 12,
        tag = u16(data, p, le),
        type = u16(data, p + 2, le),
        n = u32(data, p + 4, le),
        size = n * sizes[type];
      check(!entries.has(tag) && Number.isSafeInteger(size) && size >= 0 && size <= reader.size);
      const start = size <= 4 ? offset + 2 + p + 8 : u32(data, p + 8, le);
      check(start >= 0 && start + size <= reader.size);
      entries.set(tag, { type, count: n, size, offset: start });
      check(tag !== 34853, 'GPS IFD is not allowed');
    }
    const dir: TIFFDirectory = {
      entries,
      async bytes(tag) {
        const e = entries.get(tag);
        if (!e) return new Uint8Array();
        check(e.size <= 1_048_576);
        return reader.read(e.offset, e.size);
      },
      async values(tag) {
        const e = entries.get(tag);
        if (!e) return [];
        check(e.count <= 16384 && [1, 3, 4, 5, 13].includes(e.type));
        const b = await this.bytes(tag),
          values: number[] = [];
        for (let i = 0; i < e.count; i++) {
          const p = i * sizes[e.type];
          values.push(
            e.type === 1
              ? b[p]
              : e.type === 3
                ? u16(b, p, le)
                : e.type === 5
                  ? u32(b, p, le) / u32(b, p + 4, le)
                  : u32(b, p, le),
          );
        }
        return values;
      },
    };
    result.push(dir);
    if (entries.has(700)) checkXMP(await dir.bytes(700));
    for (const tag of [330, 34665, 40965]) pending.push(...(await dir.values(tag)));
    pending.push(u32(data, count * 12, le));
  }
  check(result.length);
  return result;
}
async function exifOrientation(bytes: Uint8Array) {
  const directories = await tiff(memoryPhotoReader(bytes));
  const orientations = await Promise.all(directories.map((d) => d.values(274)));
  return orientations.flat()[0] ?? 1;
}
export async function inspectDNG(reader: PhotoReader, asset: Asset) {
  const dirs = await tiff(reader);
  check(
    dirs.some((d) => d.entries.has(50706)),
    'Missing DNG version',
  );
  const version = await dirs.find((d) => d.entries.has(50706))!.bytes(50706);
  check(version.length === 4 && version[0] === 1 && version[1] <= 7);
  let matches = false;
  const orientation = (await dirs[0].values(274))[0] ?? 1;
  check(orientation === asset.orientation && !asset.hasGainMap);
  for (const dir of dirs) {
    const photometric = (await dir.values(262))[0];
    if (![32803, 34892].includes(photometric)) continue;
    const width = (await dir.values(256))[0],
      height = (await dir.values(257))[0];
    check(
      width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 200_000_000,
    );
    const bits = await dir.values(258);
    check(bits.length > 0 && bits.every((b) => b >= 8 && b <= 32));
    const offsets = await dir.values(dir.entries.has(324) ? 324 : 273),
      lengths = await dir.values(dir.entries.has(325) ? 325 : 279);
    check(offsets.length && offsets.length === lengths.length);
    for (let i = 0; i < offsets.length; i++)
      check(offsets[i] >= 8 && lengths[i] > 0 && offsets[i] + lengths[i] <= reader.size);
    const crop = await dir.values(50720);
    if (
      (width === asset.width && height === asset.height) ||
      (crop.length === 2 &&
        crop[0] <= width &&
        crop[1] <= height &&
        crop[0] === asset.width &&
        crop[1] === asset.height)
    )
      matches = true;
  }
  check(matches, 'RAW dimensions mismatch');
}
interface Box {
  type: string;
  start: number;
  end: number;
  body: number;
}
async function boxes(reader: PhotoReader, start = 0, end = reader.size): Promise<Box[]> {
  const result: Box[] = [];
  for (let p = start; p < end;) {
    check(end - p >= 8 && result.length < 4096);
    const h = await reader.read(p, Math.min(16, end - p));
    let n = u32(h),
      header = 8;
    if (n === 1) {
      const big = new DataView(h.buffer, h.byteOffset, h.byteLength).getBigUint64(8);
      check(big <= BigInt(Number.MAX_SAFE_INTEGER));
      n = Number(big);
      header = 16;
    } else if (n === 0) n = end - p;
    check(n >= header && p + n <= end);
    result.push({ type: text(h.subarray(4, 8)), start: p, end: p + n, body: p + header });
    p += n;
  }
  return result;
}
export async function inspectHEIF(reader: PhotoReader, asset: Asset) {
  const top = await boxes(reader),
    ftyp = top.find((b) => b.type === 'ftyp'),
    meta = top.find((b) => b.type === 'meta');
  check(
    ftyp &&
      meta &&
      ftyp.end - ftyp.body <= 256 &&
      meta.end - meta.body <= 4_194_304 &&
      !top.some((b) => b.type === 'moov'),
  );
  const brands = await reader.read(ftyp.body, ftyp.end - ftyp.body);
  check(brands.length >= 8 && brands.length % 4 === 0);
  const names = Array.from({ length: brands.length / 4 }, (_, i) =>
    text(brands.subarray(i * 4, i * 4 + 4)),
  );
  check(
    names.some((x) => ['heic', 'heix'].includes(x)) &&
      !names.some((x) => ['avis', 'avif', 'hevc', 'hevx'].includes(x)),
    'Unsupported HEIF codec/sequence',
  );
  const data = await reader.read(meta.body, meta.end - meta.body),
    local = memoryPhotoReader(data);
  check(data[0] === 0);
  const children = await boxes(local, 4),
    one = (type: string) => {
      const all = children.filter((b) => b.type === type);
      check(all.length === 1);
      return all[0];
    };
  const pitm = one('pitm'),
    primary = data[pitm.body] === 0 ? u16(data, pitm.body + 4) : u32(data, pitm.body + 4);
  const iinf = one('iinf'),
    infos = await boxes(local, iinf.body + (data[iinf.body] === 0 ? 6 : 8), iinf.end),
    items = new Map<number, string>();
  check(infos.length <= 1024);
  for (const box of infos) {
    check(box.type === 'infe');
    const p = box.body,
      v = data[p];
    check(v === 2 || v === 3);
    const id = v === 2 ? u16(data, p + 4) : u32(data, p + 4),
      off = p + (v === 2 ? 6 : 8);
    check(u16(data, off) === 0 && !items.has(id));
    items.set(id, text(data.subarray(off + 2, off + 6)));
  }
  check(items.has(primary));
  const iprp = one('iprp'),
    ipchildren = await boxes(local, iprp.body, iprp.end),
    ipco = ipchildren.find((b) => b.type === 'ipco');
  check(ipco);
  const properties = await boxes(local, ipco.body, ipco.end),
    associations = new Map<number, Box[]>();
  for (const box of ipchildren.filter((b) => b.type === 'ipma')) {
    let p = box.body;
    const v = data[p],
      wide = (data[p + 3] & 1) !== 0;
    const count = u32(data, p + 4);
    p += 8;
    check(v <= 1 && count <= 1024);
    for (let i = 0; i < count; i++) {
      const id = v === 0 ? u16(data, p) : u32(data, p);
      p += v === 0 ? 2 : 4;
      const n = data[p++],
        props: Box[] = [];
      check(items.has(id) && !associations.has(id));
      for (let j = 0; j < n; j++) {
        check(p + (wide ? 2 : 1) <= box.end);
        const index = (wide ? u16(data, p) : data[p]) & (wide ? 32767 : 127);
        p += wide ? 2 : 1;
        if (index) {
          check(index <= properties.length);
          props.push(properties[index - 1]);
        }
      }
      associations.set(id, props);
    }
    check(p === box.end);
  }
  const iloc = one('iloc');
  let p = iloc.body;
  const ver = data[p];
  check(ver <= 2);
  const offsetSize = data[p + 4] >> 4,
    lengthSize = data[p + 4] & 15,
    baseSize = data[p + 5] >> 4,
    indexSize = ver ? data[p + 5] & 15 : 0;
  p += 6;
  check(
    [offsetSize, lengthSize, baseSize, indexSize].every((n) => [0, 4, 8].includes(n)) &&
      lengthSize > 0,
  );
  const count = ver < 2 ? u16(data, p) : u32(data, p);
  p += ver < 2 ? 2 : 4;
  check(count <= 1024);
  const integer = (n: number) => {
    check(p + n <= iloc.end);
    let value = 0;
    for (let i = 0; i < n; i++) value = value * 256 + data[p++];
    check(Number.isSafeInteger(value));
    return value;
  };
  const extents = new Map<number, { offset: number; length: number }[]>(),
    idat = children.find((b) => b.type === 'idat');
  for (let i = 0; i < count; i++) {
    const id = integer(ver < 2 ? 2 : 4),
      method = ver ? integer(2) & 15 : 0;
    check(integer(2) === 0 && method <= 1 && items.has(id) && !extents.has(id));
    const base = integer(baseSize),
      n = integer(2);
    check(n > 0 && n <= 1024);
    const ranges = [];
    for (let j = 0; j < n; j++) {
      if (indexSize) check(integer(indexSize) === 0);
      const off = integer(offsetSize),
        length = integer(lengthSize);
      check(length > 0);
      let offset = base + off;
      if (method === 1) {
        check(idat && offset + length <= idat.end - idat.body);
        offset += meta.body + idat.body;
      } else
        check(top.some((b) => b.type === 'mdat' && offset >= b.body && offset + length <= b.end));
      ranges.push({ offset, length });
    }
    extents.set(id, ranges);
  }
  check(p === iloc.end && extents.has(primary));
  const references: { type: string; from: number; to: number[] }[] = [];
  for (const box of children.filter((b) => b.type === 'iref')) {
    const size = data[box.body] === 0 ? 2 : 4;
    check(data[box.body] <= 1);
    for (const ref of await boxes(local, box.body + 4, box.end)) {
      let p = ref.body;
      const from = size === 2 ? u16(data, p) : u32(data, p);
      p += size;
      const n = u16(data, p);
      p += 2;
      const to = [];
      check(n <= 1024 && p + n * size === ref.end && items.has(from));
      for (let i = 0; i < n; i++) {
        const id = size === 2 ? u16(data, p) : u32(data, p);
        p += size;
        check(items.has(id));
        to.push(id);
      }
      references.push({ type: ref.type, from, to });
    }
  }
  const dimension = (id: number) => {
    const props = associations.get(id) ?? [],
      ispe = props.find((b) => b.type === 'ispe');
    check(ispe && ispe.end - ispe.body === 12);
    const width = u32(data, ispe.body + 4),
      height = u32(data, ispe.body + 8);
    check(
      width > 0 && height > 0 && Math.max(width, height) <= 16384 && width * height <= 200_000_000,
    );
    return { width, height, props };
  };
  const main = dimension(primary);
  check(main.width === asset.width && main.height === asset.height, 'HEIF dimensions mismatch');
  for (const [id, type] of items) {
    check(extents.has(id));
    if (type === 'hvc1') {
      const { props } = dimension(id),
        config = props.find((b) => b.type === 'hvcC');
      check(config && config.end - config.body >= 23 && data[config.body] === 1);
    } else check(['grid', 'iden', 'tmap', 'Exif', 'mime', 'uri '].includes(type));
  }
  for (const [id, type] of items) {
    if (!['grid', 'iden', 'tmap'].includes(type)) continue;
    const links = references.filter((r) => r.type === 'dimg' && r.from === id);
    check(links.length === 1);
    const targets = links[0].to;
    check(!targets.includes(id));
    if (type === 'iden') {
      check(targets.length === 1 && items.get(targets[0]) === 'hvc1');
      continue;
    }
    const ranges = extents.get(id)!;
    check(ranges.length === 1 && ranges[0].length <= 65536);
    const payload = await reader.read(ranges[0].offset, ranges[0].length);
    if (type === 'tmap') {
      check(
        targets.length === 2 &&
          targets[0] !== targets[1] &&
          targets.every((t) => ['hvc1', 'grid'].includes(items.get(t) ?? '')) &&
          payload.length >= 16 &&
          payload[0] === 0,
      );
      continue;
    }
    check(payload.length >= 8 && payload[0] === 0 && payload[1] <= 1);
    const rows = payload[2] + 1,
      cols = payload[3] + 1,
      wide = (payload[1] & 1) !== 0;
    check(
      targets.length === rows * cols &&
        payload.length === (wide ? 12 : 8) &&
        targets.every((t) => items.get(t) === 'hvc1'),
    );
    const dim = dimension(id),
      width = wide ? u32(payload, 4) : u16(payload, 4),
      height = wide ? u32(payload, 8) : u16(payload, 6);
    check(dim.width === width && dim.height === height);
    const tile = dimension(targets[0]);
    check(
      width <= cols * tile.width &&
        height <= rows * tile.height &&
        width > (cols - 1) * tile.width &&
        height > (rows - 1) * tile.height,
    );
  }
  let orientation: number | undefined;
  for (const [id, type] of items) {
    if (type !== 'Exif' && type !== 'mime') continue;
    const ranges = extents.get(id)!;
    const total = ranges.reduce((n, r) => n + r.length, 0);
    check(total <= 1_048_576);
    const b = new Uint8Array(total);
    let pos = 0;
    for (const r of ranges) {
      b.set(await reader.read(r.offset, r.length), pos);
      pos += r.length;
    }
    if (type === 'mime') {
      checkXMP(b);
      continue;
    }
    check(b.length >= 12);
    const offset = 4 + u32(b);
    check(offset + 8 <= b.length);
    const value = await exifOrientation(b.subarray(offset));
    if (references.some((r) => r.type === 'cdsc' && r.from === id && r.to.includes(primary))) {
      check(orientation === undefined || orientation === value);
      orientation = value;
    }
  }
  const rotation = main.props.find((b) => b.type === 'irot');
  if (orientation === undefined) orientation = rotation ? [1, 8, 3, 6][data[rotation.body] & 3] : 1;
  check(orientation === asset.orientation, 'HEIF orientation mismatch');
  const auxiliary = references.some(
    (r) =>
      r.type === 'auxl' &&
      r.to.includes(primary) &&
      (associations.get(r.from) ?? []).some(
        (b) =>
          b.type === 'auxC' &&
          /hdrgainmap|21496|hdr-gain-map/i.test(text(data.subarray(b.body + 4, b.end))),
      ),
  );
  const iso = references.some(
    (r) =>
      r.type === 'dimg' &&
      items.get(r.from) === 'tmap' &&
      r.to.length === 2 &&
      (r.to[0] === primary || r.from === primary) &&
      r.to[1] !== primary &&
      ['hvc1', 'grid'].includes(items.get(r.to[1]) ?? ''),
  );
  check((auxiliary || iso) === asset.hasGainMap, 'HEIF gain map mismatch');
}

// Streaming multi-picture JPEG inspector: constant scan memory, bounded APP metadata.
// MPF offsets/lengths must describe every complete JPEG, including the HDR auxiliary image.
export class CameraJPEGInspector {
  private state = 'soi';
  private buffer: number[] = [];
  private marker = 0;
  private length = 0;
  private position = 0;
  private segmentStart = 0;
  private start = 0;
  private width = 0;
  private height = 0;
  private scans = 0;
  private metadataBytes = 0;
  private images: { start: number; end: number; width: number; height: number }[] = [];
  private metadata: { image: number; marker: number; offset: number; bytes: Uint8Array }[] = [];
  push(chunk: Uint8Array) {
    for (const b of chunk) {
      this.byte(b);
      this.position++;
    }
  }
  private byte(b: number) {
    if (this.state === 'done') {
      check(this.images.length < 8);
      this.state = 'soi';
      this.start = this.position;
      this.width = 0;
      this.height = 0;
      this.scans = 0;
    }
    if (this.state === 'soi') {
      this.buffer.push(b);
      if (this.buffer.length === 2) {
        check(this.buffer[0] === 255 && b === 216);
        this.buffer = [];
        this.state = 'marker';
      }
      return;
    }
    if (this.state === 'scan') {
      if (b === 255) this.state = 'scanFF';
      return;
    }
    if (this.state === 'scanFF') {
      if (b === 0 || (b >= 208 && b <= 215)) {
        this.state = 'scan';
        return;
      }
      if (b === 255) return;
      this.code(b);
      return;
    }
    if (this.state === 'marker') {
      if (!this.buffer.length) {
        check(b === 255);
        this.buffer.push(b);
        return;
      }
      if (b === 255) return;
      this.buffer = [];
      this.code(b);
      return;
    }
    if (this.state === 'length') {
      this.buffer.push(b);
      if (this.buffer.length === 2) {
        this.length = this.buffer[0] * 256 + b - 2;
        check(this.length >= 0);
        this.segmentStart = this.position + 1;
        this.buffer = [];
        this.state = 'segment';
        if (!this.length) this.segment();
      }
      return;
    }
    this.buffer.push(b);
    if (this.buffer.length === this.length) this.segment();
  }
  private code(code: number) {
    if (code === 217) {
      check(this.width && this.scans);
      this.images.push({
        start: this.start,
        end: this.position + 1,
        width: this.width,
        height: this.height,
      });
      this.state = 'done';
      return;
    }
    check([192, 194, 196, 219, 221, 218, 254].includes(code) || (code >= 224 && code <= 239));
    this.marker = code;
    this.buffer = [];
    this.state = 'length';
  }
  private segment() {
    const b = Uint8Array.from(this.buffer);
    if (this.marker === 192 || this.marker === 194) {
      check(
        !this.width &&
          b.length >= 6 &&
          [8, 12].includes(b[0]) &&
          [1, 3, 4].includes(b[5]) &&
          b.length === 6 + 3 * b[5],
      );
      this.height = u16(b, 1);
      this.width = u16(b, 3);
      check(
        this.width &&
          this.height &&
          Math.max(this.width, this.height) <= 16384 &&
          this.width * this.height <= 200_000_000,
      );
    }
    if (this.marker >= 224 || this.marker === 254) {
      this.metadataBytes += b.length;
      check(this.metadataBytes <= 4_194_304);
      this.metadata.push({
        image: this.images.length,
        marker: this.marker,
        offset: this.segmentStart,
        bytes: b,
      });
    }
    if (this.marker === 218) {
      check(this.width && b.length >= 6 && b.length === 4 + 2 * b[0]);
      this.scans++;
      this.state = 'scan';
    } else this.state = 'marker';
    this.buffer = [];
  }
  async finish(asset: Asset) {
    check(this.state === 'done' && this.images.length);
    const base = this.images[0];
    check(base.width === asset.width && base.height === asset.height);
    let orientation = 1,
      gain = false,
      mpf: { offset: number; bytes: Uint8Array } | undefined;
    for (const m of this.metadata) {
      const prefix = text(m.bytes.subarray(0, 128));
      if (m.marker === 225 && prefix.startsWith('Exif\0\0')) {
        const value = await exifOrientation(m.bytes.subarray(6));
        if (m.image === 0) orientation = value;
      }
      if (m.marker === 225 && !prefix.startsWith('Exif\0\0')) {
        const xmp = checkXMP(m.bytes);
        if (
          /hdrgm:Version|HDRGainMapVersion|aux:hdrgainmap|ns.adobe.com\/hdr-gain-map|apple.com\/HDRGainMap/i.test(
            xmp,
          )
        )
          gain = true;
      }
      if (m.marker === 226 && prefix.startsWith('urn:iso:std:iso:ts:21496:')) gain = true;
      if (m.marker === 226 && prefix.startsWith('MPF\0')) {
        check(m.image === 0 && !mpf);
        mpf = { offset: m.offset + 4, bytes: m.bytes.subarray(4) };
      }
    }
    check(orientation === asset.orientation);
    if (this.images.length > 1) {
      check(mpf);
      const dirs = await tiff(memoryPhotoReader(mpf.bytes)),
        num = (await dirs[0].values(45057))[0],
        entries = await dirs[0].bytes(45058),
        le = text(mpf.bytes.subarray(0, 2)) === 'II';
      check(num === this.images.length && entries.length === num * 16);
      for (let i = 0; i < num; i++) {
        const size = u32(entries, i * 16 + 4, le),
          relative = u32(entries, i * 16 + 8, le),
          image = this.images[i];
        check(
          image.start === (i === 0 ? 0 : mpf.offset + relative) && size === image.end - image.start,
        );
      }
    } else check(!mpf);
    check(
      (gain && this.images.length > 1) === asset.hasGainMap && (!gain || this.images.length > 1),
      'JPEG gain map mismatch',
    );
  }
}
export async function inspectOriginalPhoto(bucket: R2Bucket, key: string, asset: Asset) {
  if (asset.mime === 'image/jpeg') {
    const object = await bucket.get(key);
    check(object);
    const inspector = new CameraJPEGInspector(),
      reader = object.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        inspector.push(value);
      }
      await inspector.finish(asset);
    } finally {
      await reader.cancel();
    }
  } else if (asset.mime === 'image/heic')
    await inspectHEIF(r2PhotoReader(bucket, key, asset.bytes), asset);
  else if (asset.mime === 'image/x-adobe-dng')
    await inspectDNG(r2PhotoReader(bucket, key, asset.bytes), asset);
  else throw new Error('Unsupported original photo');
}
