import type { Region, Verdict } from '../types.js';

export const FUSION_CONFIG = {
  weights: {
    hash: 0.2,
    embedding: 0.5,
    pixel: 0.3,
  },
  maxHashBits: 64,
  embeddingFloor: 0.6,
  embeddingRange: 0.4,
  pixelChangeMultiplier: 4,
  nearDuplicateSimilarity: 0.9,
  nearDuplicateChangedFraction: 0.02,
  tamperedMatchSimilarity: 0.55,
} as const;

export interface FusionInput {
  exact: boolean;
  phashDistance: number;
  dhashDistance: number;
  embeddingCosine: number | null;
  changedFraction: number;
  regions: Region[];
}

export interface FusionResult {
  similarity: number;
  verdict: Verdict;
  hashScore: number;
  embeddingScore: number | null;
  pixelScore: number;
}

export function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function calculateHashScore(phashDistance: number, dhashDistance: number): number {
  const averageDistance = (
    clamp(phashDistance / FUSION_CONFIG.maxHashBits)
    + clamp(dhashDistance / FUSION_CONFIG.maxHashBits)
  ) / 2;
  return clamp(1 - averageDistance);
}

export function calculateEmbeddingScore(cosine: number | null): number | null {
  if (cosine === null) {
    return null;
  }
  return clamp((cosine - FUSION_CONFIG.embeddingFloor) / FUSION_CONFIG.embeddingRange);
}

export function calculatePixelScore(changedFraction: number): number {
  return clamp(1 - changedFraction * FUSION_CONFIG.pixelChangeMultiplier);
}

export function fuseLayers(input: FusionInput): FusionResult {
  const hashScore = calculateHashScore(input.phashDistance, input.dhashDistance);
  const embeddingScore = calculateEmbeddingScore(input.embeddingCosine);
  const pixelScore = calculatePixelScore(input.changedFraction);

  if (input.exact) {
    return {
      similarity: 1,
      verdict: 'identical',
      hashScore: 1,
      embeddingScore: null,
      pixelScore: 1,
    };
  }

  const similarity = embeddingScore === null
    ? (
      hashScore * (FUSION_CONFIG.weights.hash / (FUSION_CONFIG.weights.hash + FUSION_CONFIG.weights.pixel))
      + pixelScore * (FUSION_CONFIG.weights.pixel / (FUSION_CONFIG.weights.hash + FUSION_CONFIG.weights.pixel))
    )
    : hashScore * FUSION_CONFIG.weights.hash
      + embeddingScore * FUSION_CONFIG.weights.embedding
      + pixelScore * FUSION_CONFIG.weights.pixel;

  const verdict: Verdict = similarity >= FUSION_CONFIG.nearDuplicateSimilarity
    && input.changedFraction < FUSION_CONFIG.nearDuplicateChangedFraction
    ? 'near_duplicate'
    : similarity >= FUSION_CONFIG.tamperedMatchSimilarity && input.regions.length > 0
      ? 'tampered_match'
      : 'different';

  return {
    similarity: clamp(similarity),
    verdict,
    hashScore,
    embeddingScore,
    pixelScore,
  };
}
