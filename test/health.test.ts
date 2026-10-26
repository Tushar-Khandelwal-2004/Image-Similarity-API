import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';

describe('health endpoint', () => {
  it('reports the service and model state', async () => {
    const app = buildApp({ logger: false, modelReady: () => true });
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, modelReady: true });
    await app.close();
  });
});
