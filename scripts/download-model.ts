import { mkdir } from 'node:fs/promises';
import { AutoProcessor, CLIPVisionModelWithProjection, RawImage, env } from '@xenova/transformers';

const cacheDir = process.env.TRANSFORMERS_CACHE ?? '/app/model-cache';
env.cacheDir = cacheDir;
env.useFSCache = true;
env.allowRemoteModels = true;

await mkdir(cacheDir, { recursive: true });
await Promise.all([
  AutoProcessor.from_pretrained('Xenova/clip-vit-base-patch32'),
  CLIPVisionModelWithProjection.from_pretrained('Xenova/clip-vit-base-patch32'),
]);
console.log(`CLIP model cached in ${cacheDir}`);
