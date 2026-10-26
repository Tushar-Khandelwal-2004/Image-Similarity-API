import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { ClipEmbedder } from '../src/layers/embed.js';
import { exactMatch, sha256 } from '../src/layers/exact.js';
import { calculateHashScore, fuseLayers } from '../src/layers/fuse.js';
import { computeHashes, compareHashes } from '../src/layers/hash.js';
import { ingestImage } from '../src/layers/ingest.js';
import { analyzeTamper } from '../src/layers/tamper.js';
import type { IngestedImage } from '../src/types.js';

const BENCH_DIR = path.resolve(process.cwd(), 'bench');
const IMAGE_DIR = path.join(BENCH_DIR, 'images');
const RESULTS_JSON = path.join(BENCH_DIR, 'results.json');
const RESULTS_MD = path.join(BENCH_DIR, 'results.md');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const ATTACK_NAMES = [
  'jpeg_quality_60',
  'resize_50_percent',
  'gaussian_blur',
  'brightness_shift',
  'grayscale',
  'noise',
  'pasted_patch',
  'text_overlay',
] as const;

type AttackName = (typeof ATTACK_NAMES)[number];

interface SourceImage {
  name: string;
  bytes: Buffer;
}

interface BenchmarkPair {
  name: string;
  source: IngestedImage;
  suspect: IngestedImage;
  positive: boolean;
}

interface ScoredObservation {
  score: number;
  positive: boolean;
  latencyMs: number;
}

interface MethodResult {
  method: string;
  threshold: number;
  accuracy: number;
  falsePositiveRate: number;
  averageLatencyMs: number;
}

interface BenchmarkResults {
  imageCount: number;
  positivePairs: number;
  negativePairs: number;
  attacks: AttackName[];
  methods: MethodResult[];
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(1664525, state) + 1013904223;
    return (state >>> 0) / 4294967296;
  };
}

async function imageMetadata(buffer: Buffer): Promise<{ width: number; height: number }> {
  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('Benchmark image has no readable dimensions.');
  }
  return { width: metadata.width, height: metadata.height };
}

async function attackJpeg(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).jpeg({ quality: 60 }).toBuffer();
}

async function attackResize(buffer: Buffer): Promise<Buffer> {
  const size = await imageMetadata(buffer);
  return sharp(buffer)
    .resize({
      width: Math.max(1, Math.floor(size.width * 0.5)),
      height: Math.max(1, Math.floor(size.height * 0.5)),
      fit: 'inside',
    })
    .toBuffer();
}

async function attackBlur(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).blur(2).toBuffer();
}

async function attackBrightness(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).modulate({ brightness: 1.18 }).toBuffer();
}

async function attackGrayscale(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).grayscale().toBuffer();
}

async function attackNoise(buffer: Buffer, seed: number): Promise<Buffer> {
  const raw = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (raw.info.channels !== 3) {
    throw new Error('Benchmark noise attack expects an RGB image.');
  }
  const random = createRandom(seed);
  const noisy = Buffer.from(raw.data);
  for (let index = 0; index < noisy.length; index += 1) {
    const delta = Math.floor(random() * 25) - 12;
    noisy[index] = Math.max(0, Math.min(255, (noisy[index] ?? 0) + delta));
  }
  return sharp(noisy, {
    raw: {
      width: raw.info.width,
      height: raw.info.height,
      channels: 3,
    },
  }).png().toBuffer();
}

async function attackPatch(buffer: Buffer, seed: number): Promise<Buffer> {
  const size = await imageMetadata(buffer);
  const patchWidth = Math.max(12, Math.floor(size.width * 0.18));
  const patchHeight = Math.max(12, Math.floor(size.height * 0.16));
  const random = createRandom(seed);
  const patch = await sharp({
    create: {
      width: patchWidth,
      height: patchHeight,
      channels: 3,
      background: {
        r: Math.floor(150 + random() * 90),
        g: Math.floor(20 + random() * 80),
        b: Math.floor(40 + random() * 100),
      },
    },
  }).png().toBuffer();
  return sharp(buffer)
    .composite([{
      input: patch,
      left: Math.floor(random() * Math.max(1, size.width - patchWidth)),
      top: Math.floor(random() * Math.max(1, size.height - patchHeight)),
    }])
    .png()
    .toBuffer();
}

async function attackText(buffer: Buffer, index: number): Promise<Buffer> {
  const size = await imageMetadata(buffer);
  const fontSize = Math.max(14, Math.floor(size.width * 0.055));
  const svg = `<svg width="${size.width}" height="${size.height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${Math.floor(size.width * 0.04)}" y="${Math.floor(size.height * 0.82)}" width="${Math.floor(size.width * 0.55)}" height="${fontSize * 1.7}" rx="8" fill="rgba(0,0,0,0.55)" />
    <text x="${Math.floor(size.width * 0.07)}" y="${Math.floor(size.height * 0.82 + fontSize)}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="white">DEMO EDIT ${index + 1}</text>
  </svg>`;
  return sharp(buffer).composite([{ input: Buffer.from(svg), blend: 'over' }]).png().toBuffer();
}

async function generateAttack(buffer: Buffer, attack: AttackName, imageIndex: number): Promise<Buffer> {
  const seed = (0x9e3779b9 ^ Math.imul(imageIndex + 1, 0x45d9f3b)) >>> 0;
  switch (attack) {
    case 'jpeg_quality_60': return attackJpeg(buffer);
    case 'resize_50_percent': return attackResize(buffer);
    case 'gaussian_blur': return attackBlur(buffer);
    case 'brightness_shift': return attackBrightness(buffer);
    case 'grayscale': return attackGrayscale(buffer);
    case 'noise': return attackNoise(buffer, seed);
    case 'pasted_patch': return attackPatch(buffer, seed);
    case 'text_overlay': return attackText(buffer, imageIndex);
  }
}

async function loadSourceImages(): Promise<SourceImage[]> {
  const entries = await readdir(IMAGE_DIR, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort()
    .slice(0, 20);
  if (names.length < 20) {
    throw new Error(`bench/images must contain at least 20 JPEG, PNG, or WebP files; found ${names.length}.`);
  }
  return Promise.all(names.map(async (name) => ({ name, bytes: await readFile(path.join(IMAGE_DIR, name)) })));
}

async function buildPairs(images: SourceImage[]): Promise<BenchmarkPair[]> {
  const cache = new Map<string, IngestedImage>();
  const ingest = async (bytes: Buffer): Promise<IngestedImage> => {
    const key = sha256(bytes);
    const cached = cache.get(key);
    if (cached) return cached;
    const image = await ingestImage(bytes);
    cache.set(key, image);
    return image;
  };

  const pairs: BenchmarkPair[] = [];
  for (let imageIndex = 0; imageIndex < images.length; imageIndex += 1) {
    const image = images[imageIndex];
    const differentImage = images[(imageIndex + 1) % images.length];
    if (!image || !differentImage) continue;
    const source = await ingest(image.bytes);
    const negativeSuspect = await ingest(differentImage.bytes);
    for (const attack of ATTACK_NAMES) {
      const attacked = await generateAttack(image.bytes, attack, imageIndex);
      const suspect = await ingest(attacked);
      pairs.push({
        name: `${image.name}:${attack}`,
        source,
        suspect,
        positive: true,
      });
      pairs.push({
        name: `${image.name}:negative:${differentImage.name}`,
        source,
        suspect: negativeSuspect,
        positive: false,
      });
    }
  }
  return pairs;
}

async function scoreFull(pair: BenchmarkPair, embedder: ClipEmbedder): Promise<number> {
  if (exactMatch(pair.source.originalBytes, pair.suspect.originalBytes)) {
    return 1;
  }
  const [sourceHashes, suspectHashes, embedding, tamper] = await Promise.all([
    computeHashes(pair.source.buffer),
    computeHashes(pair.suspect.buffer),
    embedder.compare(pair.source, pair.suspect),
    analyzeTamper(pair.source, pair.suspect),
  ]);
  const hashes = compareHashes(sourceHashes, suspectHashes);
  return fuseLayers({
    exact: false,
    phashDistance: hashes.phashDistance,
    dhashDistance: hashes.dhashDistance,
    embeddingCosine: embedding?.cosine ?? null,
    changedFraction: tamper.changedFraction,
    regions: tamper.regions,
  }).similarity;
}

async function scorePhash(pair: BenchmarkPair): Promise<number> {
  const [sourceHashes, suspectHashes] = await Promise.all([
    computeHashes(pair.source.buffer),
    computeHashes(pair.suspect.buffer),
  ]);
  const hashes = compareHashes(sourceHashes, suspectHashes);
  return calculateHashScore(hashes.phashDistance, hashes.dhashDistance);
}

async function scorePixel(pair: BenchmarkPair): Promise<number> {
  const tamper = await analyzeTamper(pair.source, pair.suspect);
  return Math.max(0, Math.min(1, 1 - tamper.changedFraction));
}

async function scorePairs(
  pairs: BenchmarkPair[],
  scorer: (pair: BenchmarkPair) => Promise<number>,
): Promise<ScoredObservation[]> {
  const observations: ScoredObservation[] = [];
  for (const pair of pairs) {
    const startedAt = performance.now();
    const score = await scorer(pair);
    observations.push({
      score,
      positive: pair.positive,
      latencyMs: performance.now() - startedAt,
    });
  }
  return observations;
}

function chooseThreshold(observations: ScoredObservation[]): number {
  const values = [...new Set(observations.map((observation) => observation.score))].sort((a, b) => a - b);
  const candidates = new Set<number>([0, 0.5, 1, ...values]);
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous !== undefined && current !== undefined) {
      candidates.add((previous + current) / 2);
    }
  }

  let bestThreshold = 0.5;
  let bestAccuracy = -1;
  for (const threshold of candidates) {
    let correct = 0;
    for (const observation of observations) {
      const predictedPositive = observation.score >= threshold;
      if (predictedPositive === observation.positive) correct += 1;
    }
    const accuracy = observations.length === 0 ? 0 : correct / observations.length;
    if (accuracy > bestAccuracy || (accuracy === bestAccuracy && Math.abs(threshold - 0.5) < Math.abs(bestThreshold - 0.5))) {
      bestAccuracy = accuracy;
      bestThreshold = threshold;
    }
  }
  return bestThreshold;
}

function summarizeMethod(method: string, observations: ScoredObservation[]): MethodResult {
  const threshold = chooseThreshold(observations);
  let correct = 0;
  let falsePositives = 0;
  let negatives = 0;
  let totalLatency = 0;
  for (const observation of observations) {
    const predictedPositive = observation.score >= threshold;
    if (predictedPositive === observation.positive) correct += 1;
    if (!observation.positive) {
      negatives += 1;
      if (predictedPositive) falsePositives += 1;
    }
    totalLatency += observation.latencyMs;
  }
  return {
    method,
    threshold,
    accuracy: observations.length === 0 ? 0 : correct / observations.length,
    falsePositiveRate: negatives === 0 ? 0 : falsePositives / negatives,
    averageLatencyMs: observations.length === 0 ? 0 : totalLatency / observations.length,
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatNumber(value: number): string {
  return value.toFixed(3);
}

async function writeResults(results: BenchmarkResults): Promise<void> {
  const markdown = [
    '# Benchmark results',
    '',
    `Evaluated ${results.imageCount} source images, ${results.positivePairs} positive pairs, and ${results.negativePairs} negative pairs.`,
    '',
    '| Method | Chosen threshold | Accuracy | False positive rate | Average latency (ms) |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...results.methods.map((method) => `| ${method.method} | ${formatNumber(method.threshold)} | ${formatPercent(method.accuracy)} | ${formatPercent(method.falsePositiveRate)} | ${formatNumber(method.averageLatencyMs)} |`),
    '',
  ].join('\n');
  await Promise.all([
    writeFile(RESULTS_JSON, `${JSON.stringify(results, null, 2)}\n`, 'utf8'),
    writeFile(RESULTS_MD, markdown, 'utf8'),
  ]);
}

async function main(): Promise<void> {
  const images = await loadSourceImages();
  const pairs = await buildPairs(images);
  console.log(`Benchmarking ${pairs.length} pairs across ${images.length} images and ${ATTACK_NAMES.length} attacks.`);

  const embedder = new ClipEmbedder();
  await embedder.initialize();
  console.log(`CLIP model ready: ${embedder.modelReady}`);

  const full = await scorePairs(pairs, (pair) => scoreFull(pair, embedder));
  const phash = await scorePairs(pairs, scorePhash);
  const pixel = await scorePairs(pairs, scorePixel);
  const results: BenchmarkResults = {
    imageCount: images.length,
    positivePairs: pairs.filter((pair) => pair.positive).length,
    negativePairs: pairs.filter((pair) => !pair.positive).length,
    attacks: [...ATTACK_NAMES],
    methods: [
      summarizeMethod('full fusion', full),
      summarizeMethod('pHash only', phash),
      summarizeMethod('pixel difference only', pixel),
    ],
  };
  await writeResults(results);
  console.log(`Results written to ${path.relative(process.cwd(), RESULTS_MD)} and ${path.relative(process.cwd(), RESULTS_JSON)}.`);
  console.table(results.methods);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
