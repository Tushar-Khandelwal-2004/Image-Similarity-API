import { describe, expect, it } from 'vitest';
import {
  calculateEmbeddingScore,
  calculateHashScore,
  calculatePixelScore,
  fuseLayers,
} from '../src/layers/fuse.js';

describe('fusion and verdicts', () => {
  it('calculates the individual layer scores', () => {
    expect(calculateHashScore(6, 8)).toBeCloseTo(0.890625);
    expect(calculateEmbeddingScore(0.91)).toBeCloseTo(0.775);
    expect(calculatePixelScore(0.07)).toBeCloseTo(0.72);
  });

  it('marks a high-scoring pair with a region as a tampered match', () => {
    const result = fuseLayers({
      exact: false,
      phashDistance: 6,
      dhashDistance: 8,
      embeddingCosine: 0.91,
      changedFraction: 0.07,
      regions: [{ x: 20, y: 20, width: 30, height: 30 }],
    });

    expect(result.similarity).toBeCloseTo(0.781625);
    expect(result.verdict).toBe('tampered_match');
  });

  it('marks a very similar pair without a meaningful change as near duplicate', () => {
    const result = fuseLayers({
      exact: false,
      phashDistance: 2,
      dhashDistance: 3,
      embeddingCosine: 0.95,
      changedFraction: 0.01,
      regions: [],
    });

    expect(result.similarity).toBeGreaterThanOrEqual(0.9);
    expect(result.verdict).toBe('near_duplicate');
  });

  it('redistributes the embedding weight when the model is unavailable', () => {
    const result = fuseLayers({
      exact: false,
      phashDistance: 6.4,
      dhashDistance: 6.4,
      embeddingCosine: null,
      changedFraction: 0.05,
      regions: [],
    });

    expect(result.embeddingScore).toBeNull();
    expect(result.similarity).toBeCloseTo(0.84);
    expect(result.verdict).toBe('different');
  });

  it('always returns identical for an exact match', () => {
    const result = fuseLayers({
      exact: true,
      phashDistance: 64,
      dhashDistance: 64,
      embeddingCosine: null,
      changedFraction: 1,
      regions: [{ x: 0, y: 0, width: 1, height: 1 }],
    });

    expect(result).toEqual({
      similarity: 1,
      verdict: 'identical',
      hashScore: 1,
      embeddingScore: null,
      pixelScore: 1,
    });
  });
});
