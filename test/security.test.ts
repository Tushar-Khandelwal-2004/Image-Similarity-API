import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';

function multipartBody(data: Buffer): { body: Buffer; contentType: string } {
  const boundary = '----image-similarity-security-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="source.png"\r\nContent-Type: image/png\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="suspect"; filename="suspect.png"\r\nContent-Type: image/png\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function image(): Promise<Buffer> {
  return sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 20, g: 40, b: 80 } },
  }).png().toBuffer();
}

describe('API protection and readiness endpoints', () => {
  it('rejects requests without multipart files', async () => {
    const app = buildApp({ logger: false });
    const response = await app.inject({ method: 'POST', url: '/v1/compare' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'MISSING_FILE' }, requestId: expect.any(String) });
    await app.close();
  });

  it('rejects unreadable image bytes', async () => {
    const app = buildApp({ logger: false });
    const payload = multipartBody(Buffer.from('not an image'));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/compare',
      headers: { 'content-type': payload.contentType },
      payload: payload.body,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_IMAGE' } });
    await app.close();
  });

  it('rejects oversized uploads before image processing', async () => {
    const app = buildApp({ logger: false });
    const payload = multipartBody(Buffer.alloc(10 * 1024 * 1024 + 1));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/compare',
      headers: { 'content-type': payload.contentType },
      payload: payload.body,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: 'FILE_TOO_LARGE' } });
    await app.close();
  });

  it('distinguishes liveness from model readiness', async () => {
    const app = buildApp({ logger: false, modelReady: () => false });

    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ ok: true, modelReady: false });

    await app.close();
  });

  it('requires an API key when configured and returns a request ID', async () => {
    const app = buildApp({ logger: false, apiKey: 'test-key' });
    const payload = multipartBody(await image());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/compare',
      headers: { 'content-type': payload.contentType },
      payload: payload.body,
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' }, requestId: expect.any(String) });
    await app.close();
  });

  it('limits comparison requests per client', async () => {
    const app = buildApp({ logger: false, rateLimit: { max: 1, windowMs: 60_000 } });
    const payload = multipartBody(await image());
    const request = {
      method: 'POST' as const,
      url: '/v1/compare',
      headers: { 'content-type': payload.contentType },
      payload: payload.body,
    };

    expect((await app.inject(request)).statusCode).toBe(200);
    const limited = await app.inject(request);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    await app.close();
  });

  it('answers allowed CORS preflight requests', async () => {
    const app = buildApp({ logger: false, corsOrigin: 'https://client.example' });
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/compare',
      headers: { origin: 'https://client.example' },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://client.example');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    await app.close();
  });
});
