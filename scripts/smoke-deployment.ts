import { readFile } from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.env.DEPLOYMENT_URL ?? 'http://127.0.0.1:7860').replace(/\/$/, '');
const root = path.resolve(process.cwd());
const timeoutMs = Number(process.env.DEPLOYMENT_TIMEOUT_MS ?? '180000');
const startedAt = Date.now();

interface HealthResponse {
  ok: boolean;
  modelReady: boolean;
}

interface CompareResponse {
  verdict: string;
  similarity: number;
  regions: Array<{ x: number; y: number; width: number; height: number }>;
}

async function waitForHealth(): Promise<HealthResponse> {
  let lastError = 'no response';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) {
        const health = await response.json() as HealthResponse;
        if (health.ok && health.modelReady) return health;
        lastError = `health not ready: ${JSON.stringify(health)}`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Deployment did not become ready within ${timeoutMs} ms: ${lastError}`);
}

async function compare(sourceName: string, suspectName: string): Promise<CompareResponse> {
  const form = new FormData();
  const source = await readFile(path.join(root, 'public', 'samples', sourceName));
  const suspect = await readFile(path.join(root, 'public', 'samples', suspectName));
  form.append('source', new Blob([source], { type: sourceName.endsWith('.jpg') ? 'image/jpeg' : 'image/png' }), sourceName);
  form.append('suspect', new Blob([suspect], { type: suspectName.endsWith('.jpg') ? 'image/jpeg' : 'image/png' }), suspectName);
  const response = await fetch(`${baseUrl}/v1/compare`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`${sourceName}/${suspectName} returned HTTP ${response.status}`);
  return response.json() as Promise<CompareResponse>;
}

async function main(): Promise<void> {
  const health = await waitForHealth();
  const identical = await compare('identical-source.png', 'identical-suspect.png');
  const filtered = await compare('filtered-source.png', 'filtered-suspect.jpg');
  const tampered = await compare('tampered-source.png', 'tampered-suspect.png');
  if (identical.verdict !== 'identical') throw new Error(`Expected identical, received ${identical.verdict}.`);
  if (filtered.verdict !== 'near_duplicate') throw new Error(`Expected near_duplicate, received ${filtered.verdict}.`);
  if (tampered.verdict !== 'tampered_match' || tampered.regions.length === 0) throw new Error(`Expected tampered_match with a region, received ${tampered.verdict}.`);
  console.log(JSON.stringify({ baseUrl, health, presets: { identical: identical.verdict, filtered: filtered.verdict, tampered: tampered.verdict }, elapsedMs: Date.now() - startedAt }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
