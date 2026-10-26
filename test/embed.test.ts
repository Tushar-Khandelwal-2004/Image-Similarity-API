import { describe, expect, it } from 'vitest';
import { cosineSimilarity, l2Normalize } from '../src/layers/embed.js';

describe('embedding math', () => {
  it('L2 normalizes vectors', () => {
    const normalized = l2Normalize([3, 4]);

    expect(normalized[0]).toBeCloseTo(0.6);
    expect(normalized[1]).toBeCloseTo(0.8);
  });

  it('computes cosine similarity independently of vector scale', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });
});
