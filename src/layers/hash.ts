import sharp from 'sharp';
import type { HashLayerResult, HashPair } from '../types.js';

const PHASH_SIZE = 32;
const PHASH_BLOCK_SIZE = 8;
const DHASH_WIDTH = 9;
const DHASH_HEIGHT = 8;

interface GrayscalePixels {
  data: Buffer;
  width: number;
  height: number;
}

async function grayscalePixels(buffer: Buffer, width: number, height: number): Promise<GrayscalePixels> {
  const result = await sharp(buffer)
    .greyscale()
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data: result.data,
    width: result.info.width,
    height: result.info.height,
  };
}

function dctCoefficient(pixels: Buffer, width: number, u: number, v: number): number {
  let sum = 0;
  const normalizerU = u === 0 ? 1 / Math.sqrt(2) : 1;
  const normalizerV = v === 0 ? 1 / Math.sqrt(2) : 1;

  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = pixels[y * width + x] ?? 0;
      sum += pixel
        * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * width))
        * Math.cos(((2 * y + 1) * v * Math.PI) / (2 * width));
    }
  }

  return (normalizerU * normalizerV * sum * 2) / width;
}

export function pHashFromPixels(pixels: Buffer, width = PHASH_SIZE): bigint {
  const coefficients: number[] = [];
  for (let v = 0; v < PHASH_BLOCK_SIZE; v += 1) {
    for (let u = 0; u < PHASH_BLOCK_SIZE; u += 1) {
      coefficients.push(dctCoefficient(pixels, width, u, v));
    }
  }

  const nonDc = coefficients.slice(1).sort((a, b) => a - b);
  const median = nonDc[Math.floor(nonDc.length / 2)] ?? 0;
  return coefficients.reduce((hash, coefficient) => (hash << 1n) | (coefficient > median ? 1n : 0n), 0n);
}

export function dHashFromPixels(pixels: Buffer, width = DHASH_WIDTH, height = DHASH_HEIGHT): bigint {
  let hash = 0n;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const left = pixels[y * width + x] ?? 0;
      const right = pixels[y * width + x + 1] ?? 0;
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  return hash;
}

export async function computeHashes(buffer: Buffer): Promise<Pick<HashPair, 'phash' | 'dhash'>> {
  const [phashPixels, dhashPixels] = await Promise.all([
    grayscalePixels(buffer, PHASH_SIZE, PHASH_SIZE),
    grayscalePixels(buffer, DHASH_WIDTH, DHASH_HEIGHT),
  ]);

  return {
    phash: pHashFromPixels(phashPixels.data, phashPixels.width),
    dhash: dHashFromPixels(dhashPixels.data, dhashPixels.width, dhashPixels.height),
  };
}

function asBigInt(hash: bigint | Uint8Array): bigint {
  if (typeof hash === 'bigint') {
    return hash;
  }

  let value = 0n;
  for (const byte of hash) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

export function hammingDistance(first: bigint | Uint8Array, second: bigint | Uint8Array): number {
  let difference = asBigInt(first) ^ asBigInt(second);
  let distance = 0;
  while (difference !== 0n) {
    difference &= difference - 1n;
    distance += 1;
  }
  return distance;
}

export function compareHashes(source: HashPair, suspect: HashPair): HashLayerResult {
  return {
    ...source,
    phashDistance: hammingDistance(source.phash, suspect.phash),
    dhashDistance: hammingDistance(source.dhash, suspect.dhash),
  };
}
