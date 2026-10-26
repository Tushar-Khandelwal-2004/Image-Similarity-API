import sharp from 'sharp';
import {
  AutoProcessor,
  CLIPVisionModelWithProjection,
  RawImage,
  type Processor,
} from '@xenova/transformers';

export const CLIP_MODEL_ID = 'Xenova/clip-vit-base-patch32';
export const EMBEDDING_TIMEOUT_MS = 5_000;

export type Embedding = Float32Array;

export interface EmbeddingComparison {
  cosine: number;
}

interface ClipModelOutput {
  image_embeds: {
    data: Float32Array | number[];
  };
}

export interface EmbeddingProvider {
  readonly modelReady: boolean;
  initialize(): Promise<void>;
  compare(source: { buffer: Buffer; sha256: string }, suspect: { buffer: Buffer; sha256: string }): Promise<EmbeddingComparison | null>;
}

export function l2Normalize(values: ArrayLike<number>): Embedding {
  let squaredLength = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0;
    squaredLength += value * value;
  }

  const length = Math.sqrt(squaredLength);
  const normalized = new Float32Array(values.length);
  if (length === 0) {
    return normalized;
  }

  for (let index = 0; index < values.length; index += 1) {
    normalized[index] = (values[index] ?? 0) / length;
  }
  return normalized;
}

export function cosineSimilarity(first: ArrayLike<number>, second: ArrayLike<number>): number {
  if (first.length !== second.length || first.length === 0) {
    return 0;
  }

  const firstNormalized = l2Normalize(first);
  const secondNormalized = l2Normalize(second);
  let cosine = 0;
  for (let index = 0; index < firstNormalized.length; index += 1) {
    cosine += (firstNormalized[index] ?? 0) * (secondNormalized[index] ?? 0);
  }
  return cosine;
}

async function toRawImage(buffer: Buffer): Promise<RawImage> {
  const raw = await sharp(buffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new RawImage(raw.data, raw.info.width, raw.info.height, 3);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Embedding inference exceeded ${timeoutMs} ms.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class ClipEmbedder implements EmbeddingProvider {
  private processor: Processor | null = null;
  private visionModel: CLIPVisionModelWithProjection | null = null;
  private initialization: Promise<void> | null = null;
  private available = false;
  private readonly cache = new Map<string, Embedding>();

  public get modelReady(): boolean {
    return this.available && this.processor !== null && this.visionModel !== null;
  }

  public initialize(): Promise<void> {
    if (this.initialization) {
      return this.initialization;
    }

    this.initialization = this.loadModel();
    return this.initialization;
  }

  public async compare(
    source: { buffer: Buffer; sha256: string },
    suspect: { buffer: Buffer; sha256: string },
  ): Promise<EmbeddingComparison | null> {
    if (!this.modelReady) {
      return null;
    }

    try {
      const [sourceEmbedding, suspectEmbedding] = await Promise.all([
        this.getEmbedding(source.sha256, source.buffer),
        this.getEmbedding(suspect.sha256, suspect.buffer),
      ]);
      return {
        cosine: cosineSimilarity(sourceEmbedding, suspectEmbedding),
      };
    } catch (error: unknown) {
      this.available = false;
      console.warn(JSON.stringify({ event: 'embedding_unavailable', message: error instanceof Error ? error.message : 'unknown error' }));
      return null;
    }
  }

  private async loadModel(): Promise<void> {
    try {
      const [processor, visionModel] = await Promise.all([
        AutoProcessor.from_pretrained(CLIP_MODEL_ID),
        CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL_ID),
      ]);
      this.processor = processor;
      this.visionModel = visionModel;

      const warmupImage = new RawImage(new Uint8Array([255, 255, 255]), 1, 1, 3);
      await this.runInference(warmupImage);
      this.available = true;
    } catch (error: unknown) {
      this.available = false;
      console.warn(JSON.stringify({ event: 'embedding_model_unavailable', message: error instanceof Error ? error.message : 'unknown error' }));
    }
  }

  private async getEmbedding(sha256: string, buffer: Buffer): Promise<Embedding> {
    const cached = this.cache.get(sha256);
    if (cached) {
      return cached;
    }

    const rawImage = await toRawImage(buffer);
    const embedding = await withTimeout(this.runInference(rawImage), EMBEDDING_TIMEOUT_MS);
    this.cache.set(sha256, embedding);
    return embedding;
  }

  private async runInference(image: RawImage): Promise<Embedding> {
    if (!this.processor || !this.visionModel) {
      throw new Error('The CLIP model is not ready.');
    }

    const inputs = await this.processor(image);
    const output = await this.visionModel(inputs) as unknown as ClipModelOutput;
    return l2Normalize(output.image_embeds.data);
  }
}
