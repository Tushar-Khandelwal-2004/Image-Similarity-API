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
import { ingestImage, MAX_UPLOAD_BYTES } from './layers/ingest.js';
import { AppError, type ErrorResponse, type Verdict } from './types.js';

export interface ServerOptions {
  logger?: boolean;
  modelReady?: () => boolean;
  embedder?: EmbeddingProvider;
}

export function buildApp(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  const projectRoot = path.resolve(process.cwd());

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

  app.get('/health', async () => ({
    ok: true,
    modelReady: options.modelReady?.() ?? options.embedder?.modelReady ?? false,
  }));

  app.post('/v1/compare', async (request, reply) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    let ingestMs = 0;
    let hashMs = 0;
    let embedMs = 0;

    try {
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
        const timingMs = {
          total: Math.round(performance.now() - startedAt),
          ingest: ingestMs,
          hash: exactMs,
          embed: 0,
          tamper: 0,
        };
        logRequest(requestId, timingMs, 'identical');
        return reply.send({
          similarity: 1,
          verdict: 'identical' satisfies Verdict,
          layers: {
            exact: true,
            phashDistance: 0,
            dhashDistance: 0,
            hashScore: 1,
            embeddingCosine: null,
            embeddingScore: null,
          },
          regions: [],
          heatmapPngBase64: '',
          normalizedSize: suspect.size,
          timingMs,
          requestId,
          degraded: false,
        });
      }

      const hashStartedAt = performance.now();
      const [sourceHashes, suspectHashes] = await Promise.all([
        computeHashes(source.buffer),
        computeHashes(suspect.buffer),
      ]);
      const hashes = compareHashes(sourceHashes, suspectHashes);
      hashMs = Math.round(performance.now() - hashStartedAt);
      const hashScore = Math.max(
        0,
        Math.min(1, 1 - ((hashes.phashDistance / 64 + hashes.dhashDistance / 64) / 2)),
      );
      const embeddingStartedAt = performance.now();
      const embedding = options.embedder
        ? await options.embedder.compare(source, suspect)
        : null;
      embedMs = Math.round(performance.now() - embeddingStartedAt);
      const embeddingCosine = embedding?.cosine ?? null;
      const embeddingScore = embeddingCosine === null
        ? null
        : Math.max(0, Math.min(1, (embeddingCosine - 0.6) / 0.4));
      const degraded = embedding === null;
      const verdict: Verdict = hashScore >= 0.9 ? 'near_duplicate' : 'different';
      const timingMs = {
        total: Math.round(performance.now() - startedAt),
        ingest: ingestMs,
        hash: hashMs,
        embed: embedMs,
        tamper: 0,
      };
      logRequest(requestId, timingMs, verdict);

      return reply.send({
        similarity: hashScore,
        verdict,
        layers: {
          exact: false,
          phashDistance: hashes.phashDistance,
          dhashDistance: hashes.dhashDistance,
          hashScore,
          embeddingCosine,
          embeddingScore,
        },
        regions: [],
        heatmapPngBase64: '',
        normalizedSize: suspect.size,
        timingMs,
        requestId,
        ...(degraded ? { degraded: true } : {}),
      });
    } catch (error: unknown) {
      const appError = toAppError(error);
      const timingMs = {
        total: Math.round(performance.now() - startedAt),
        ingest: ingestMs,
        hash: hashMs,
        embed: embedMs,
        tamper: 0,
      };
      logRequest(requestId, timingMs, 'error', appError.code);
      return reply.status(appError.statusCode).send({
        error: {
          code: appError.code,
          message: appError.message,
        },
      } satisfies ErrorResponse);
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

function logRequest(requestId: string, timingMs: Record<string, number>, verdict: string, errorCode?: string): void {
  console.log(JSON.stringify({ requestId, timingMs, verdict, ...(errorCode ? { errorCode } : {}) }));
}

export async function startServer(): Promise<void> {
  const embedder = new ClipEmbedder();
  const app = buildApp({ embedder });
  const portValue = Number.parseInt(process.env.PORT ?? '3000', 10);
  const port = Number.isFinite(portValue) && portValue > 0 ? portValue : 3000;

  await app.listen({ host: '0.0.0.0', port });
  void embedder.initialize();
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
