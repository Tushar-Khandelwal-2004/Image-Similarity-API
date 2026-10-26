import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { computeHashes, hammingDistance } from '../src/layers/hash.js';

async function makePattern(background: string, accent: string, variant: 'base' | 'different'): Promise<Buffer> {
  const svg = `
    <svg width="128" height="128" xmlns="http://www.w3.org/2000/svg">
      <rect width="128" height="128" fill="${background}" />
      <rect x="16" y="20" width="66" height="72" rx="8" fill="${accent}" />
      <circle cx="${variant === 'base' ? 98 : 36}" cy="98" r="18" fill="${variant === 'base' ? '#111827' : '#facc15'}" />
      <path d="M 10 112 L 118 12" stroke="${variant === 'base' ? '#f8fafc' : '#0f172a'}" stroke-width="5" />
    </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

describe('perceptual hashes', () => {
  it('returns zero distance for an image compared with itself', async () => {
    const image = await makePattern('#2563eb', '#f8fafc', 'base');
    const hashes = await computeHashes(image);

    expect(hammingDistance(hashes.phash, hashes.phash)).toBe(0);
    expect(hammingDistance(hashes.dhash, hashes.dhash)).toBe(0);
  });

  it('keeps a JPEG recompressed copy close to the original', async () => {
    const image = await makePattern('#2563eb', '#f8fafc', 'base');
    const recompressed = await sharp(image).jpeg({ quality: 55 }).toBuffer();
    const [sourceHashes, suspectHashes] = await Promise.all([
      computeHashes(image),
      computeHashes(recompressed),
    ]);

    expect(hammingDistance(sourceHashes.phash, suspectHashes.phash)).toBeLessThanOrEqual(10);
    expect(hammingDistance(sourceHashes.dhash, suspectHashes.dhash)).toBeLessThanOrEqual(12);
  });

  it('separates an unrelated image with a larger distance', async () => {
    const source = await makePattern('#2563eb', '#f8fafc', 'base');
    const unrelated = await makePattern('#be123c', '#22c55e', 'different');
    const [sourceHashes, unrelatedHashes] = await Promise.all([
      computeHashes(source),
      computeHashes(unrelated),
    ]);

    expect(hammingDistance(sourceHashes.phash, unrelatedHashes.phash)).toBeGreaterThan(10);
    expect(hammingDistance(sourceHashes.dhash, unrelatedHashes.dhash)).toBeGreaterThan(12);
  });
});
