const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const CONSTANTS = Uint32Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x1_0000_0000));

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function rotateLeft(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

/** RFC 1321 MD5 for browser runtimes where Web Crypto does not expose MD5. */
export function md5(bytes: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil((bytes.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.byteLength] = 0x80;
  const bitLength = BigInt(bytes.byteLength) * 8n;
  for (let index = 0; index < 8; index += 1) padded[paddedLength - 8 + index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);

  const state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  const words = new Uint32Array(16);
  for (let offset = 0; offset < padded.byteLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4;
      words[index] = (padded[position] ?? 0) | ((padded[position + 1] ?? 0) << 8) | ((padded[position + 2] ?? 0) << 16) | ((padded[position + 3] ?? 0) << 24);
    }
    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    for (let index = 0; index < 64; index += 1) {
      let mixed: number;
      let wordIndex: number;
      if (index < 16) {
        mixed = (b & c) | (~b & d);
        wordIndex = index;
      } else if (index < 32) {
        mixed = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
      } else if (index < 48) {
        mixed = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
      } else {
        mixed = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
      }
      const sum = (a + mixed + CONSTANTS[index]! + words[wordIndex]!) >>> 0;
      const rotated = rotateLeft(sum, SHIFTS[index]!);
      const nextB = (b + rotated) >>> 0;
      a = d;
      d = c;
      c = b;
      b = nextB;
    }
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
  }

  const digest = new Uint8Array(16);
  for (let word = 0; word < 4; word += 1) {
    const value = state[word]!;
    digest[word * 4] = value & 0xff;
    digest[word * 4 + 1] = (value >>> 8) & 0xff;
    digest[word * 4 + 2] = (value >>> 16) & 0xff;
    digest[word * 4 + 3] = (value >>> 24) & 0xff;
  }
  return digest;
}

export function hmacMd5(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockKey = new Uint8Array(64);
  blockKey.set(key.byteLength > blockKey.byteLength ? md5(key) : key);
  const innerPad = new Uint8Array(64);
  const outerPad = new Uint8Array(64);
  for (let index = 0; index < 64; index += 1) {
    innerPad[index] = blockKey[index]! ^ 0x36;
    outerPad[index] = blockKey[index]! ^ 0x5c;
  }
  return md5(concatBytes(outerPad, md5(concatBytes(innerPad, message))));
}
