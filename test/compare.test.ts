import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../src/layers/embed.js';
import { buildApp } from '../src/server.js';

function multipartBody(parts: Array<{ name: string; filename: string; contentType: string; data: Buffer }>): {
  body: Buffer;
  contentType: string;
} {
  const boundary = '----image-similarity-test-boundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType}\r\n\r\n`,
    ));
    chunks.push(part.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function makeImage(format: 'png' | 'jpeg'): Promise<Buffer> {
  const image = sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 37, g: 99, b: 235 },
    },
  });
  return format === 'png' ? image.png().toBuffer() : image.jpeg({ quality: 60 }).toBuffer();
}

describe('compare ingestion and hash route', () => {
  it('accepts source and suspect images and returns exact/hash data', async () => {
    const app = buildApp({ logger: false });
    const source = await makeImage('png');
    const suspect = await makeImage('jpeg');
    const payload = multipartBody([
      { name: 'source', filename: 'source.png', contentType: 'image/png', data: source },
      { name: 'suspect', filename: 'suspect.jpg', contentType: 'image/jpeg', data: suspect },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/compare',
      headers: { 'content-type': payload.contentType },
      payload: payload.body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      verdict: expect.any(String),
      layers: {
        exact: false,
        phashDistance: expect.any(Number),
        dhashDistance: expect.any(Number),
        hashScore: expect.any(Number),
      },
      normalizedSize: { width: 64, height: 64 },
    });
    await app.close();
  });

  it('returns identical without calculating hash distances for equal bytes', async () => {
    const app = buildApp({ logger: false });
    const image = await makeImage('png');
    const payload = multipartBody([
      { name: 'source', filename: 'source.png', contentType: 'image/png', data: image },
      { name: 'suspect', filename: 'suspect.png', contentType: 'image/png', data: image },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/compare',
      headers: { 'content-type': payload.contentType },
      payload: payload.body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      similarity: 1,
      verdict: 'identical',
      layers: { exact: true, phashDistance: 0, dhashDistance: 0, hashScore: 1 },
    });
    await app.close();
  });

  it('includes a normalized embedding score when the provider is ready', async () => {
    const embedder: EmbeddingProvider = {
      modelReady: true,
      initialize: async () => undefined,
      compare: async () => ({ cosine: 0.92 }),
    };
    const app = buildApp({ logger: false, embedder });
    const source = await makeImage('png');
    const suspect = await makeImage('jpeg');
    const payload = multipartBody([
      { name: 'source', filename: 'source.png', contentType: 'image/png', data: source },
      { name: 'suspect', filename: 'suspect.jpg', contentType: 'image/jpeg', data: suspect },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/compare',
      headers: { 'content-type': payload.contentType },
      payload: payload.body,
    });

    expect(response.statusCode).toBe(200);
    const result = response.json() as { layers: { embeddingCosine: number; embeddingScore: number }; degraded?: boolean };
    expect(result.layers.embeddingCosine).toBeCloseTo(0.92);
    expect(result.layers.embeddingScore).toBeCloseTo(0.8);
    expect(result.degraded).toBeUndefined();
    await app.close();
  });
});
