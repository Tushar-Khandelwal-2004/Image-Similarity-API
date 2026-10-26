import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ingestImage } from '../src/layers/ingest.js';
import { analyzeTamper } from '../src/layers/tamper.js';

describe('tamper map', () => {
  it('finds a pasted colored rectangle and returns a heatmap', async () => {
    const source = await sharp({
      create: {
        width: 128,
        height: 128,
        channels: 3,
        background: { r: 245, g: 245, b: 245 },
      },
    }).png().toBuffer();
    const patch = await sharp({
      create: {
        width: 40,
        height: 30,
        channels: 3,
        background: { r: 220, g: 30, b: 50 },
      },
    }).png().toBuffer();
    const suspect = await sharp(source)
      .composite([{ input: patch, left: 32, top: 44 }])
      .png()
      .toBuffer();

    const result = await analyzeTamper(await ingestImage(source), await ingestImage(suspect));
    const rectangleOverlap = result.regions.some((region) => (
      region.x < 72
      && region.x + region.width > 32
      && region.y < 74
      && region.y + region.height > 44
    ));
    const metadata = await sharp(result.heatmapPng).metadata();

    expect(rectangleOverlap).toBe(true);
    expect(result.regions.length).toBeGreaterThanOrEqual(1);
    expect(result.changedFraction).toBeGreaterThan(0);
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(128);
    expect(metadata.height).toBe(128);
  });
});
