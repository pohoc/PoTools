const MASK_64 = 0xffff_ffff_ffff_ffffn;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
] as const;
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
] as const;

function readWord(bytes: Uint8Array, offset: number): bigint {
  let word = 0n;
  for (let index = 7; index >= 0; index -= 1) word = (word << 8n) | BigInt(bytes[offset + index] ?? 0);
  return word;
}

function rotateRight(value: bigint, count: bigint): bigint {
  return ((value >> count) | (value << (64n - count))) & MASK_64;
}

/** BLAKE2b with the standard 64-byte digest parameters used by Node's blake2b512. */
export function blake2b512(input: Uint8Array): Uint8Array {
  const state: bigint[] = [...IV];
  state[0] = state[0]! ^ 0x01010040n;
  let offset = 0;
  let counter = 0n;

  const compress = (block: Uint8Array, final: boolean) => {
    const words = Array.from({ length: 16 }, (_, index) => readWord(block, index * 8));
    const work = [...state, ...IV];
    work[12] = work[12]! ^ (counter & MASK_64);
    work[13] = work[13]! ^ (counter >> 64n);
    if (final) work[14] = work[14]! ^ MASK_64;

    const mix = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
      work[a] = (work[a]! + work[b]! + x) & MASK_64;
      work[d] = rotateRight(work[d]! ^ work[a]!, 32n);
      work[c] = (work[c]! + work[d]!) & MASK_64;
      work[b] = rotateRight(work[b]! ^ work[c]!, 24n);
      work[a] = (work[a]! + work[b]! + y) & MASK_64;
      work[d] = rotateRight(work[d]! ^ work[a]!, 16n);
      work[c] = (work[c]! + work[d]!) & MASK_64;
      work[b] = rotateRight(work[b]! ^ work[c]!, 63n);
    };

    for (const schedule of SIGMA) {
      mix(0, 4, 8, 12, words[schedule[0]!]!, words[schedule[1]!]!);
      mix(1, 5, 9, 13, words[schedule[2]!]!, words[schedule[3]!]!);
      mix(2, 6, 10, 14, words[schedule[4]!]!, words[schedule[5]!]!);
      mix(3, 7, 11, 15, words[schedule[6]!]!, words[schedule[7]!]!);
      mix(0, 5, 10, 15, words[schedule[8]!]!, words[schedule[9]!]!);
      mix(1, 6, 11, 12, words[schedule[10]!]!, words[schedule[11]!]!);
      mix(2, 7, 8, 13, words[schedule[12]!]!, words[schedule[13]!]!);
      mix(3, 4, 9, 14, words[schedule[14]!]!, words[schedule[15]!]!);
    }
    for (let index = 0; index < 8; index += 1) state[index] = state[index]! ^ work[index]! ^ work[index + 8]!;
  };

  while (offset + 128 < input.length) {
    counter += 128n;
    compress(input.subarray(offset, offset + 128), false);
    offset += 128;
  }
  const finalBlock = new Uint8Array(128);
  finalBlock.set(input.subarray(offset));
  counter += BigInt(input.length - offset);
  compress(finalBlock, true);

  const digest = new Uint8Array(64);
  for (let wordIndex = 0; wordIndex < 8; wordIndex += 1) {
    let word = state[wordIndex]!;
    for (let byteIndex = 0; byteIndex < 8; byteIndex += 1) {
      digest[wordIndex * 8 + byteIndex] = Number(word & 0xffn);
      word >>= 8n;
    }
  }
  return digest;
}
