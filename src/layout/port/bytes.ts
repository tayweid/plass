// UTF-8 byte-offset infrastructure for the Typst line-break port.
//
// Typst's algorithm addresses text exclusively by UTF-8 byte offset; the
// sidecar primitives (segment, word_bounds, hyphenate) speak the same
// offsets. JS strings are UTF-16, so the port wraps each paragraph text in
// a ByteText that translates between the two once, up front. All ranges in
// the port are byte ranges.

export class ByteText {
  /** The text as a JS string. */
  readonly str: string;
  /** Total UTF-8 byte length. */
  readonly len: number;
  /** byte offset → JS string index (length len+1; interior bytes of a
   * multi-byte char map to the char's start). */
  private byteToJs: Uint32Array;
  /** byte offset → codepoint ordinal (for per-codepoint tables like the
   * sidecar's lb_classes). */
  private byteToCp: Uint32Array;
  /** JS string index → byte offset (length str.length+1). */
  private jsToByte: Uint32Array;

  constructor(str: string) {
    this.str = str;
    // One pass over codepoints.
    let bytes = 0;
    const jsLen = str.length;
    const jsToByte = new Uint32Array(jsLen + 1);
    // First pass to compute byte length cheaply.
    for (let i = 0; i < jsLen; ) {
      const cp = str.codePointAt(i)!;
      jsToByte[i] = bytes;
      const cpLen = cp > 0xffff ? 2 : 1;
      if (cpLen === 2) jsToByte[i + 1] = bytes;
      bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      i += cpLen;
    }
    jsToByte[jsLen] = bytes;
    this.len = bytes;
    this.jsToByte = jsToByte;

    const byteToJs = new Uint32Array(bytes + 1);
    const byteToCp = new Uint32Array(bytes + 1);
    let b = 0;
    let cpIdx = 0;
    for (let i = 0; i < jsLen; ) {
      const cp = str.codePointAt(i)!;
      const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      for (let k = 0; k < n; k++) {
        byteToJs[b + k] = i;
        byteToCp[b + k] = cpIdx;
      }
      b += n;
      i += cp > 0xffff ? 2 : 1;
      cpIdx++;
    }
    byteToJs[bytes] = jsLen;
    byteToCp[bytes] = cpIdx;
    this.byteToJs = byteToJs;
    this.byteToCp = byteToCp;
  }

  /** JS string index for a byte offset. */
  js(byte: number): number {
    return this.byteToJs[byte];
  }

  /** Byte offset for a JS string index. */
  byte(js: number): number {
    return this.jsToByte[js];
  }

  /** Codepoint ordinal for a byte offset (indexes per-codepoint tables). */
  cp(byte: number): number {
    return this.byteToCp[byte];
  }

  /** Substring for a byte range. */
  slice(start: number, end: number): string {
    return this.str.substring(this.byteToJs[start], this.byteToJs[end]);
  }

  /** The char starting at a byte offset ('' at end). */
  charAt(byte: number): string {
    const i = this.byteToJs[byte];
    const cp = this.str.codePointAt(i);
    return cp === undefined ? '' : String.fromCodePoint(cp);
  }

  /** The char ending just before a byte offset ('' at start) — the mirror
   * of Rust's `text[..point].chars().next_back()`. */
  charBefore(byte: number): string {
    const i = this.byteToJs[byte];
    if (i === 0) return '';
    const cp = this.str.codePointAt(
      i >= 2 && isLowSurrogate(this.str.charCodeAt(i - 1)) ? i - 2 : i - 1,
    )!;
    return String.fromCodePoint(cp);
  }
}

function isLowSurrogate(u: number): boolean {
  return u >= 0xdc00 && u <= 0xdfff;
}

/** UTF-8 byte length of a string (mirror of Rust str::len). */
export function utf8Len(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Number of codepoints (mirror of Rust chars().count()). */
export function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
