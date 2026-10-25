// Streaming JPEG structure/metadata validator. At most one JPEG segment (64 KiB) is buffered.
// Pixel decoding and abuse moderation remain a separate publication gate.
export class JPEGInspector {
  private buffer: number[] = [];
  private state: 'soi' | 'marker' | 'length' | 'segment' | 'scan' | 'scanFF' | 'done' = 'soi';
  private marker = 0;
  private expected = 0;
  private dimensions: { width: number; height: number } | undefined;
  private scans = 0;
  private orientationSeen = false;
  constructor(
    private width: number,
    private height: number,
    private orientation = 1,
  ) {}
  push(bytes: Uint8Array) {
    for (const byte of bytes) this.byte(byte);
  }
  private byte(b: number) {
    if (this.state === 'done') throw new Error('Trailing JPEG data');
    if (this.state === 'soi') {
      this.buffer.push(b);
      if (this.buffer.length === 2) {
        if (this.buffer[0] !== 255 || b !== 216) throw new Error('Not JPEG');
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
      this.markerCode(b);
      return;
    }
    if (this.state === 'marker') {
      if (!this.buffer.length) {
        if (b !== 255) throw new Error('Expected marker');
        this.buffer.push(b);
        return;
      }
      if (b === 255) return;
      this.buffer = [];
      this.markerCode(b);
      return;
    }
    if (this.state === 'length') {
      this.buffer.push(b);
      if (this.buffer.length === 2) {
        this.expected = this.buffer[0] * 256 + b - 2;
        if (this.expected < 0) throw new Error('Invalid segment');
        this.buffer = [];
        this.state = 'segment';
        if (!this.expected) this.segment();
      }
      return;
    }
    this.buffer.push(b);
    if (this.buffer.length === this.expected) this.segment();
  }
  private markerCode(marker: number) {
    if (marker === 217) {
      if (!this.dimensions || !this.scans) throw new Error('Incomplete JPEG');
      this.state = 'done';
      return;
    }
    if (![192, 194, 196, 219, 221, 218, 224, 225, 226].includes(marker))
      throw new Error('Unsupported JPEG marker or private metadata');
    this.marker = marker;
    this.buffer = [];
    this.state = 'length';
  }
  private segment() {
    const b = this.buffer;
    if (this.marker === 192 || this.marker === 194) {
      if (
        this.dimensions ||
        b.length < 6 ||
        b[0] !== 8 ||
        ![1, 3].includes(b[5]) ||
        b.length !== 6 + b[5] * 3
      )
        throw new Error('Invalid JPEG frame');
      this.dimensions = { height: b[1] * 256 + b[2], width: b[3] * 256 + b[4] };
      if (this.dimensions.width !== this.width || this.dimensions.height !== this.height)
        throw new Error('Dimensions mismatch');
    }
    if (
      this.marker === 224 &&
      !(
        b.length >= 14 &&
        String.fromCharCode(...b.slice(0, 5)) === 'JFIF\0' &&
        b.length === 14 + 3 * b[12] * b[13]
      )
    )
      throw new Error('Invalid JFIF');
    if (
      this.marker === 226 &&
      !(
        b.length >= 14 &&
        String.fromCharCode(...b.slice(0, 12)) === 'ICC_PROFILE\0' &&
        b[12] > 0 &&
        b[12] <= b[13]
      )
    )
      throw new Error('Unexpected application metadata');
    if (this.marker === 225) {
      const canonical = [
        69,
        120,
        105,
        102,
        0,
        0,
        73,
        73,
        42,
        0,
        8,
        0,
        0,
        0,
        1,
        0,
        18,
        1,
        3,
        0,
        1,
        0,
        0,
        0,
        this.orientation,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      ];
      if (
        this.orientationSeen ||
        b.length !== canonical.length ||
        b.some((v, i) => v !== canonical[i])
      )
        throw new Error('Private EXIF or orientation mismatch');
      this.orientationSeen = true;
    }
    if (this.marker === 218) {
      if (!this.dimensions || b.length < 6 || b.length !== 4 + 2 * b[0])
        throw new Error('Invalid scan');
      this.scans++;
      this.state = 'scan';
    } else this.state = 'marker';
    this.buffer = [];
  }
  finish() {
    if (this.state !== 'done') throw new Error('Truncated JPEG');
    if (this.orientation !== 1 && !this.orientationSeen) throw new Error('Missing orientation');
  }
}
