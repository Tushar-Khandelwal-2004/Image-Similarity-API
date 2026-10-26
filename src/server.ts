import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface ServerOptions {
  logger?: boolean;
  modelReady?: () => boolean;
}

export function buildApp(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  app.register(fastifyStatic, {
    root: path.join(projectRoot, 'public'),
    prefix: '/',
  });

  app.get('/health', async () => ({
    ok: true,
    modelReady: options.modelReady?.() ?? false,
  }));

  return app;
}

export async function startServer(): Promise<void> {
  const app = buildApp();
  const portValue = Number.parseInt(process.env.PORT ?? '3000', 10);
  const port = Number.isFinite(portValue) && portValue > 0 ? portValue : 3000;

  await app.listen({ host: '0.0.0.0', port });
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
