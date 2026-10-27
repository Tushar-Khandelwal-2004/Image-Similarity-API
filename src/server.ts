import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareHashes, computeHashes } from './layers/hash.js';
import { exactMatch } from './layers/exact.js';
import { ClipEmbedder, type EmbeddingProvider } from './layers/embed.js';
import { fuseLayers } from './layers/fuse.js';
import { ingestImage, MAX_UPLOAD_BYTES } from './layers/ingest.js';
import { analyzeTamper } from './layers/tamper.js';
import { AppError, type CompareResponse, type ErrorResponse } from './types.js';

export interface ServerOptions {
  logger?: boolean;
  modelReady?: () => boolean;
  embedder?: EmbeddingProvider;
  apiKey?: string;
  corsOrigin?: string;
  rateLimit?: Partial<RateLimitOptions>;
  maxConcurrentComparisons?: number;
  maxQueuedComparisons?: number;
  requestTimeoutMs?: number;
}

interface RateLimitOptions {
  max: number;
  windowMs: number;
}

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

class FixedWindowRateLimiter {
  private readonly records = new Map<string, RateLimitRecord>();

  public constructor(private readonly options: RateLimitOptions) {}

  public check(key: string): void {
    const now = Date.now();
    const existing = this.records.get(key);
    if (!existing || existing.resetAt <= now) {
      this.records.set(key, { count: 1, resetAt: now + this.options.windowMs });
      this.prune(now);
      return;
    }
    if (existing.count >= this.options.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      throw new AppError('RATE_LIMITED', 'Too many comparison requests. Please try again later.', 429, retryAfterSeconds);
    }
    existing.count += 1;
  }

  private prune(now: number): void {
    if (this.records.size < 1_000) return;
    for (const [key, record] of this.records) {
      if (record.resetAt <= now) this.records.delete(key);
    }
  }
}

class ComparisonLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  public constructor(private readonly maxActive: number, private readonly maxQueued: number) {}

  public acquire(): Promise<() => void> {
    if (this.active < this.maxActive) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    if (this.queue.length >= this.maxQueued) {
      throw new AppError('RATE_LIMITED', 'The comparison service is busy. Please try again later.', 429, 5);
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function modelReady(options: ServerOptions): boolean {
  return options.modelReady?.() ?? options.embedder?.modelReady ?? false;
}

export function buildApp(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
    requestTimeout: options.requestTimeoutMs ?? 30_000,
    trustProxy: process.env.TRUST_PROXY === 'true',
  });
  const projectRoot = path.resolve(process.cwd());
  const apiKey = options.apiKey ?? process.env.API_KEY;
  const corsOrigin = options.corsOrigin ?? process.env.CORS_ORIGIN;
  const rateLimit: RateLimitOptions = {
    max: positiveInteger(options.rateLimit?.max, positiveInteger(Number(process.env.RATE_LIMIT_MAX), 60)),
    windowMs: positiveInteger(options.rateLimit?.windowMs, positiveInteger(Number(process.env.RATE_LIMIT_WINDOW_MS), 60_000)),
  };
  const rateLimiter = new FixedWindowRateLimiter(rateLimit);
  const comparisonLimiter = new ComparisonLimiter(
    positiveInteger(options.maxConcurrentComparisons, positiveInteger(Number(process.env.MAX_CONCURRENT_COMPARISONS), 2)),
    positiveInteger(options.maxQueuedComparisons, positiveInteger(Number(process.env.MAX_QUEUED_COMPARISONS), 8)),
  );

  app.register(fastifyMultipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 2,
      fields: 0,
      parts: 2,
    },
    throwFileSizeLimit: true,
  });

  app.register(fastifyStatic, {
    root: path.join(projectRoot, 'public'),
    prefix: '/',
  });

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    const allowed = corsOrigin === '*' || (origin && corsOrigin?.split(',').map((value) => value.trim()).includes(origin));
    if (allowed && origin) {
      reply.header('access-control-allow-origin', corsOrigin === '*' ? '*' : origin);
      reply.header('vary', 'Origin');
      reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
      reply.header('access-control-allow-headers', 'content-type,x-api-key');
      reply.header('access-control-max-age', '600');
    }
    if (request.method === 'OPTIONS' && allowed) {
      return reply.code(204).send();
    }
  });

  app.get('/health', async () => ({
    ok: true,
    modelReady: modelReady(options),
  }));

  app.get('/health/live', async () => ({ ok: true }));

  app.get('/health/ready', async (_request, reply) => {
    const ready = modelReady(options);
    return reply.code(ready ? 200 : 503).send({ ok: ready, modelReady: ready });
  });

  app.post('/v1/compare', async (request, reply) => {
    const requestId = randomUUID();
    reply.header('x-request-id', requestId);
    const startedAt = performance.now();
    let ingestMs = 0;
    let hashMs = 0;
    let embedMs = 0;
    let tamperMs = 0;
    let release: (() => void) | undefined;

    try {
      if (apiKey && request.headers['x-api-key'] !== apiKey) {
        throw new AppError('UNAUTHORIZED', 'A valid x-api-key header is required.', 401);
      }
      rateLimiter.check(request.ip);
      release = await comparisonLimiter.acquire();
      const uploaded = await readMultipartFiles(request);
      const ingestStartedAt = performance.now();
      const [source, suspect] = await Promise.all([
        ingestImage(uploaded.source),
        ingestImage(uploaded.suspect),
      ]);
      ingestMs = Math.round(performance.now() - ingestStartedAt);

      const exactStartedAt = performance.now();
      const exact = exactMatch(source.originalBytes, suspect.originalBytes);
      const exactMs = Math.round(performance.now() - exactStartedAt);

      if (exact) {
        const fusion = fuseLayers({
          exact: true,
          phashDistance: 0,
          dhashDistance: 0,
          embeddingCosine: null,
          changedFraction: 0,
          regions: [],
        });
        const timingMs = {
          total: Math.round(performance.now() - startedAt),
          ingest: ingestMs,
          hash: exactMs,
          embed: 0,
          tamper: 0,
        };
        logRequest(app, requestId, timingMs, 'identical');
        return reply.send({
          similarity: fusion.similarity,
          verdict: fusion.verdict,
          layers: {
            exact: true,
            phashDistance: 0,
            dhashDistance: 0,
            hashScore: fusion.hashScore,
            embeddingCosine: null,
            embeddingScore: fusion.embeddingScore,
            pixelScore: fusion.pixelScore,
            changedFraction: 0,
          },
          regions: [],
          heatmapPngBase64: '',
          normalizedSize: suspect.size,
          timingMs,
          requestId,
          degraded: false,
        } satisfies CompareResponse);
      }

      const hashStartedAt = performance.now();
      const [sourceHashes, suspectHashes] = await Promise.all([
        computeHashes(source.buffer),
        computeHashes(suspect.buffer),
      ]);
      const hashes = compareHashes(sourceHashes, suspectHashes);
      hashMs = Math.round(performance.now() - hashStartedAt);
      const embeddingStartedAt = performance.now();
      const embedding = options.embedder
        ? await options.embedder.compare(source, suspect)
        : null;
      embedMs = Math.round(performance.now() - embeddingStartedAt);
      const embeddingCosine = embedding?.cosine ?? null;
      const degraded = embedding === null;
      const tamperStartedAt = performance.now();
      const tamper = await analyzeTamper(source, suspect);
      tamperMs = Math.round(performance.now() - tamperStartedAt);
      const fusion = fuseLayers({
        exact: false,
        phashDistance: hashes.phashDistance,
        dhashDistance: hashes.dhashDistance,
        embeddingCosine,
        changedFraction: tamper.changedFraction,
        regions: tamper.regions,
      });
      const timingMs = {
        total: Math.round(performance.now() - startedAt),
        ingest: ingestMs,
        hash: hashMs,
        embed: embedMs,
        tamper: tamperMs,
      };
      logRequest(app, requestId, timingMs, fusion.verdict);

      return reply.send({
        similarity: fusion.similarity,
        verdict: fusion.verdict,
        layers: {
          exact: false,
          phashDistance: hashes.phashDistance,
          dhashDistance: hashes.dhashDistance,
          hashScore: fusion.hashScore,
          embeddingCosine,
          embeddingScore: fusion.embeddingScore,
          pixelScore: fusion.pixelScore,
          changedFraction: tamper.changedFraction,
        },
        regions: tamper.regions,
        heatmapPngBase64: tamper.heatmapPng.toString('base64'),
        normalizedSize: suspect.size,
        timingMs,
        requestId,
        ...(degraded ? { degraded: true } : {}),
      } satisfies CompareResponse);
    } catch (error: unknown) {
      const appError = toAppError(error);
      const timingMs = {
        total: Math.round(performance.now() - startedAt),
        ingest: ingestMs,
        hash: hashMs,
        embed: embedMs,
        tamper: tamperMs,
      };
      if (appError.retryAfterSeconds !== undefined) {
        reply.header('retry-after', String(appError.retryAfterSeconds));
      }
      logRequest(app, requestId, timingMs, 'error', appError.code);
      return reply.status(appError.statusCode).send({
        error: {
          code: appError.code,
          message: appError.message,
        },
        requestId,
      } satisfies ErrorResponse);
    } finally {
      release?.();
    }
  });

  return app;
}

interface UploadedFiles {
  source: Buffer;
  suspect: Buffer;
}

async function readMultipartFiles(request: FastifyRequest): Promise<UploadedFiles> {
  if (!request.isMultipart()) {
    throw new AppError('MISSING_FILE', 'Send source and suspect as multipart file fields.', 400);
  }

  const files: Partial<Record<'source' | 'suspect', Buffer>> = {};
  try {
    for await (const part of request.parts()) {
      if (part.type !== 'file') {
        continue;
      }
      if (part.fieldname !== 'source' && part.fieldname !== 'suspect') {
        await part.toBuffer();
        continue;
      }
      if (files[part.fieldname] !== undefined) {
        throw new AppError('MISSING_FILE', `Only one ${part.fieldname} file may be submitted.`, 400);
      }
      files[part.fieldname] = await part.toBuffer();
    }
  } catch (error: unknown) {
    const tooLargeError = request.server.multipartErrors.RequestFileTooLargeError;
    if (error instanceof tooLargeError) {
      throw new AppError('FILE_TOO_LARGE', 'Each image must be 10 MB or smaller.', 413);
    }
    throw error;
  }

  if (!files.source || !files.suspect) {
    throw new AppError('MISSING_FILE', 'Both source and suspect file fields are required.', 400);
  }

  return {
    source: files.source,
    suspect: files.suspect,
  };
}

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  return new AppError('INTERNAL', 'An unexpected error occurred while comparing the images.', 500);
}

function logRequest(app: FastifyInstance, requestId: string, timingMs: Record<string, number>, verdict: string, errorCode?: string): void {
  app.log.info({ event: 'compare_request', requestId, timingMs, verdict, ...(errorCode ? { errorCode } : {}) }, 'image comparison');
}

export async function startServer(): Promise<void> {
  const embedder = new ClipEmbedder();
  const app = buildApp({ embedder });
  const portValue = Number.parseInt(process.env.PORT ?? '3000', 10);
  const port = Number.isFinite(portValue) && portValue > 0 ? portValue : 3000;

  await app.listen({ host: '0.0.0.0', port });
  void embedder.initialize();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    await app.close();
  };
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
