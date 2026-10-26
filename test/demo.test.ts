import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';

describe('demo static assets', () => {
  it('serves the demo page and prepared sample files', async () => {
    const app = buildApp({ logger: false });
    const page = await app.inject({ method: 'GET', url: '/' });
    const sample = await app.inject({ method: 'GET', url: '/samples/tampered-suspect.png' });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Image Similarity API');
    expect(page.body).toContain('Tampered copy');
    expect(sample.statusCode).toBe(200);
    expect(sample.headers['content-type']).toContain('image/png');
    await app.close();
  });
});
