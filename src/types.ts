export type ErrorCode = 'MISSING_FILE' | 'FILE_TOO_LARGE' | 'INVALID_IMAGE' | 'INTERNAL';

export type Verdict = 'identical' | 'near_duplicate' | 'tampered_match' | 'different';

export interface ImageSize {
  width: number;
  height: number;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NormalizedImage {
  buffer: Buffer;
  size: ImageSize;
  format: 'jpeg' | 'png' | 'webp';
}

export interface IngestedImage extends NormalizedImage {
  originalBytes: Buffer;
  sha256: string;
}

export interface HashPair {
  phash: bigint;
  dhash: bigint;
}

export interface HashLayerResult extends HashPair {
  phashDistance: number;
  dhashDistance: number;
}

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
  };
}

export interface LayerScores {
  exact: boolean;
  phashDistance: number;
  dhashDistance: number;
  hashScore: number;
  embeddingCosine: number | null;
  embeddingScore: number | null;
  pixelScore: number;
  changedFraction: number;
}

export interface TimingMs {
  total: number;
  ingest: number;
  hash: number;
  embed: number;
  tamper: number;
}

export interface CompareResponse {
  similarity: number;
  verdict: Verdict;
  layers: LayerScores;
  regions: Region[];
  heatmapPngBase64: string;
  normalizedSize: ImageSize;
  timingMs: TimingMs;
  requestId: string;
  degraded?: boolean;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;

  public constructor(code: ErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
