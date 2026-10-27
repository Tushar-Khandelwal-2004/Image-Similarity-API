import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { writeCharts } from './charts.js';
import { ClipEmbedder } from '../src/layers/embed.js';
import { exactMatch } from '../src/layers/exact.js';
import { calculateEmbeddingScore, calculateHashScore, calculatePixelScore, fuseLayers } from '../src/layers/fuse.js';
import { compareHashes, computeHashes } from '../src/layers/hash.js';
import { ingestImage } from '../src/layers/ingest.js';
import { analyzeTamper } from '../src/layers/tamper.js';
import type { IngestedImage } from '../src/types.js';

const SEED = 20261027;
const ROOT = path.resolve(process.cwd());
const COCO_DIR = path.join(ROOT, 'bench', 'coco_images');
const STARTER_DIR = path.join(ROOT, 'bench', 'starter_images');
const RESULTS_JSON = path.join(ROOT, 'bench', 'results.json');
const RESULTS_MD = path.join(ROOT, 'bench', 'results.md');
const CHART_DIR = path.join(ROOT, 'docs', 'benchmarks');
const QUICK = process.argv.includes('--quick');

type PairKind = 'positive' | 'easy' | 'hard';
type MethodName =
  | 'fusion'
  | 'fusion_fitted'
  | 'hash only'
  | 'embedding only'
  | 'pixel only'
  | 'hash + embedding'
  | 'embedding + pixel'
  | 'pHash Hamming similarity'
  | 'SSIM'
  | 'color histogram correlation';

interface AttackSpec {
  name: string;
  category: string;
  kind: string;
}

interface BenchImage {
  index: number;
  id: string;
  bytes: Buffer;
  image: IngestedImage;
}

interface Pair {
  id: string;
  sourceIndex: number;
  targetIndex: number;
  attack: AttackSpec;
  kind: PairKind;
  source: IngestedImage;
  suspect: IngestedImage;
}

interface LayerScores {
  hash: number;
  embedding: number;
  pixel: number;
  phash: number;
  ssim: number;
  histogram: number;
  fusion: number;
}

interface LayerLatency {
  hash: number;
  embedding: number;
  pixel: number;
  ssim: number;
  histogram: number;
  full: number;
}

interface ScoredPair extends Pair {
  layers: LayerScores;
  latency: LayerLatency;
}

interface Observation {
  pairId: string;
  sourceIndex: number;
  attack: string;
  category: string;
  kind: PairKind;
  positive: boolean;
  score: number;
  predictedPositive?: boolean;
  latencyMs: number;
}

interface MetricSet {
  count: number;
  positives: number;
  negatives: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  falsePositiveRate: number;
  rocAuc: number;
  tprAtOnePercentFpr: number;
}

interface AttackMetric {
  attack: string;
  category: string;
  count: number;
  truePositiveRate: number;
}

interface CategoryMetric {
  category: string;
  truePositiveRate: number;
}

interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
}

interface MethodResult {
  name: MethodName;
  threshold: number;
  heldOut: MetricSet & { easyNegatives: MetricSet; hardNegatives: MetricSet };
  inSample: MetricSet & { easyNegatives: MetricSet; hardNegatives: MetricSet };
  perAttack: AttackMetric[];
  perCategory: CategoryMetric[];
  roc: Array<{ fpr: number; tpr: number }>;
  latency: LatencySummary;
  fittedWeights?: number[];
}

interface BenchmarkResults {
  config: {
    seed: number;
    quick: boolean;
    attackCount: number;
    imageCount: number;
    positivePairs: number;
    easyNegativePairs: number;
    hardNegativePairs: number;
    methods: MethodName[];
    crossValidation: string;
  };
  versions: {
    node: string;
    cpu: string;
    sharp: string;
    modelReady: boolean;
  };
  attacks: AttackSpec[];
  layers: Record<string, LatencySummary>;
  methods: MethodResult[];
  confusionMatrix: { threshold: number; truePositive: number; falsePositive: number; trueNegative: number; falseNegative: number };
  scoreDistribution: { positive: number[]; negative: number[] };
}

export const ATTACKS: AttackSpec[] = [
  { name: 'jpeg_90', category: 'compression', kind: 'jpeg' },
  { name: 'jpeg_70', category: 'compression', kind: 'jpeg' },
  { name: 'jpeg_50', category: 'compression', kind: 'jpeg' },
  { name: 'jpeg_30', category: 'compression', kind: 'jpeg' },
  { name: 'resize_75', category: 'resize', kind: 'resize' },
  { name: 'resize_50', category: 'resize', kind: 'resize' },
  { name: 'resize_25', category: 'resize', kind: 'resize' },
  { name: 'blur_sigma_1', category: 'blur', kind: 'blur' },
  { name: 'blur_sigma_2', category: 'blur', kind: 'blur' },
  { name: 'blur_sigma_4', category: 'blur', kind: 'blur' },
  { name: 'noise_sigma_10', category: 'noise', kind: 'noise' },
  { name: 'noise_sigma_25', category: 'noise', kind: 'noise' },
  { name: 'noise_sigma_50', category: 'noise', kind: 'noise' },
  { name: 'brightness_plus_30', category: 'brightness_contrast', kind: 'brightness' },
  { name: 'brightness_minus_30', category: 'brightness_contrast', kind: 'brightness' },
  { name: 'contrast_0.6', category: 'brightness_contrast', kind: 'contrast' },
  { name: 'contrast_1.5', category: 'brightness_contrast', kind: 'contrast' },
  { name: 'grayscale', category: 'color', kind: 'grayscale' },
  { name: 'saturation_0.3', category: 'color', kind: 'saturation' },
  { name: 'saturation_2.0', category: 'color', kind: 'saturation' },
  { name: 'sharpen', category: 'filter_flip', kind: 'sharpen' },
  { name: 'horizontal_flip', category: 'filter_flip', kind: 'flip' },
  { name: 'center_crop_90', category: 'crop', kind: 'crop' },
  { name: 'center_crop_75', category: 'crop', kind: 'crop' },
  { name: 'center_crop_50', category: 'crop', kind: 'crop' },
  { name: 'rotate_5', category: 'rotation', kind: 'rotate' },
  { name: 'rotate_15', category: 'rotation', kind: 'rotate' },
  { name: 'pasted_patch_5', category: 'edits', kind: 'patch' },
  { name: 'pasted_patch_15', category: 'edits', kind: 'patch' },
  { name: 'text_overlay', category: 'edits', kind: 'text' },
  { name: 'blurred_rectangle_10', category: 'edits', kind: 'blurred_rectangle' },
];

const METHOD_NAMES: MethodName[] = [
  'fusion', 'fusion_fitted', 'hash only', 'embedding only', 'pixel only',
  'hash + embedding', 'embedding + pixel', 'pHash Hamming similarity', 'SSIM',
  'color histogram correlation',
];

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(1664525, state) + 1013904223;
    return (state >>> 0) / 4294967296;
  };
}

function gaussianRandom(random: () => number): number {
  const u = Math.max(random(), Number.EPSILON);
  const v = Math.max(random(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function dimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Benchmark image has no dimensions.');
  return { width: metadata.width, height: metadata.height };
}

async function attackImage(buffer: Buffer, attack: AttackSpec, imageIndex: number): Promise<Buffer> {
  const size = await dimensions(buffer);
  const random = seededRandom(SEED + imageIndex * 997 + attack.name.length * 31);
  const match = attack.name.match(/(?:jpeg_|resize_|blur_sigma_|noise_sigma_|center_crop_|rotate_|pasted_patch_)([0-9.]+)/);
  const amount = match?.[1] ? Number(match[1]) : 0;
  if (attack.kind === 'jpeg') return sharp(buffer).jpeg({ quality: amount }).toBuffer();
  if (attack.kind === 'resize') {
    return sharp(buffer).resize({ width: Math.max(1, Math.round(size.width * amount / 100)), height: Math.max(1, Math.round(size.height * amount / 100)), fit: 'fill' }).resize(size.width, size.height, { fit: 'fill' }).png().toBuffer();
  }
  if (attack.kind === 'blur') return sharp(buffer).blur(amount).png().toBuffer();
  if (attack.kind === 'noise') {
    const raw = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const output = Buffer.from(raw.data);
    for (let index = 0; index < output.length; index += 1) {
      const value = (output[index] ?? 0) + gaussianRandom(random) * amount;
      output[index] = Math.max(0, Math.min(255, Math.round(value)));
    }
    return sharp(output, { raw: { width: raw.info.width, height: raw.info.height, channels: raw.info.channels } }).png().toBuffer();
  }
  if (attack.name === 'brightness_plus_30') return sharp(buffer).modulate({ brightness: 1.3 }).png().toBuffer();
  if (attack.name === 'brightness_minus_30') return sharp(buffer).modulate({ brightness: 0.7 }).png().toBuffer();
  if (attack.kind === 'contrast') return sharp(buffer).linear(amount, 128 * (1 - amount)).png().toBuffer();
  if (attack.kind === 'grayscale') return sharp(buffer).grayscale().png().toBuffer();
  if (attack.kind === 'saturation') return sharp(buffer).modulate({ saturation: amount }).png().toBuffer();
  if (attack.kind === 'sharpen') return sharp(buffer).sharpen(2).png().toBuffer();
  if (attack.kind === 'flip') return sharp(buffer).flop().png().toBuffer();
  if (attack.kind === 'crop') {
    const keep = amount / 100;
    const cropWidth = Math.max(1, Math.round(size.width * keep));
    const cropHeight = Math.max(1, Math.round(size.height * keep));
    return sharp(buffer).extract({ left: Math.floor((size.width - cropWidth) / 2), top: Math.floor((size.height - cropHeight) / 2), width: cropWidth, height: cropHeight }).resize(size.width, size.height, { fit: 'fill' }).png().toBuffer();
  }
  if (attack.kind === 'rotate') return sharp(buffer).rotate(amount, { background: { r: 255, g: 255, b: 255, alpha: 1 } }).resize(size.width, size.height, { fit: 'fill' }).png().toBuffer();
  const fraction = attack.name === 'pasted_patch_5' ? 0.05 : attack.name === 'pasted_patch_15' ? 0.15 : 0.1;
  const regionWidth = Math.max(8, Math.round(Math.sqrt(size.width * size.height * fraction)));
  const regionHeight = Math.max(8, Math.round(size.width * size.height * fraction / regionWidth));
  const left = Math.floor(random() * Math.max(1, size.width - regionWidth));
  const top = Math.floor(random() * Math.max(1, size.height - regionHeight));
  if (attack.kind === 'patch') {
    const patch = await sharp({ create: { width: regionWidth, height: regionHeight, channels: 3, background: { r: 215, g: 35, b: 65 } } }).png().toBuffer();
    return sharp(buffer).composite([{ input: patch, left, top }]).png().toBuffer();
  }
  if (attack.kind === 'blurred_rectangle') {
    const patch = await sharp(buffer).extract({ left, top, width: Math.min(regionWidth, size.width - left), height: Math.min(regionHeight, size.height - top) }).blur(8).png().toBuffer();
    return sharp(buffer).composite([{ input: patch, left, top }]).png().toBuffer();
  }
  const svg = `<svg width="${size.width}" height="${size.height}" xmlns="http://www.w3.org/2000/svg"><rect x="${left}" y="${top}" width="${regionWidth}" height="${regionHeight}" rx="8" fill="rgba(0,0,0,0.58)"/><text x="${left + 8}" y="${top + Math.max(18, Math.round(regionHeight / 2))}" font-family="Arial" font-size="${Math.max(14, Math.round(size.width * 0.05))}" fill="white">EDITED</text></svg>`;
  return sharp(buffer).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
}

async function loadImages(quick: boolean): Promise<BenchImage[]> {
  const directory = quick ? STARTER_DIR : COCO_DIR;
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(jpe?g|png|webp)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .slice(0, quick ? 3 : 30);
  if (names.length !== (quick ? 3 : 30)) throw new Error(`Expected ${quick ? 3 : 30} benchmark images in ${path.relative(ROOT, directory)}. Run pnpm bench:data first for the COCO benchmark.`);
  return Promise.all(names.map(async (name, index) => {
    const bytes = await readFile(path.join(directory, name));
    await sharp(bytes).metadata();
    return { index, id: path.parse(name).name, bytes, image: await ingestImage(bytes) };
  }));
}

async function pixelSignature(image: IngestedImage): Promise<Float32Array> {
  const raw = await sharp(image.buffer).resize(16, 16, { fit: 'fill' }).greyscale().raw().toBuffer();
  const signature = new Float32Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) signature[index] = raw[index] ?? 0;
  return signature;
}

function signatureDistance(first: Float32Array, second: Float32Array): number {
  let total = 0;
  for (let index = 0; index < first.length; index += 1) total += Math.abs((first[index] ?? 0) - (second[index] ?? 0));
  return total / Math.max(1, first.length);
}

async function createPairs(images: BenchImage[]): Promise<Pair[]> {
  const signatures = await Promise.all(images.map((image) => pixelSignature(image.image)));
  const random = seededRandom(SEED);
  const pairs: Pair[] = [];
  for (const source of images) {
    let easyIndex = Math.floor(random() * images.length);
    if (easyIndex === source.index) easyIndex = (easyIndex + 1) % images.length;
    let hardIndex = -1;
    let hardDistance = Number.POSITIVE_INFINITY;
    for (const candidate of images) {
      if (candidate.index === source.index) continue;
      const distance = signatureDistance(signatures[source.index] ?? new Float32Array(), signatures[candidate.index] ?? new Float32Array());
      if (distance < hardDistance) { hardDistance = distance; hardIndex = candidate.index; }
    }
    for (const attack of ATTACKS) {
      const attackedSource = await ingestImage(await attackImage(source.image.buffer, attack, source.index));
      const easyTarget = images[easyIndex];
      const hardTarget = images[hardIndex];
      if (!easyTarget || !hardTarget) throw new Error('Could not select negative benchmark images.');
      const attackedEasy = await ingestImage(await attackImage(easyTarget.image.buffer, attack, easyTarget.index));
      const attackedHard = await ingestImage(await attackImage(hardTarget.image.buffer, attack, hardTarget.index));
      pairs.push({ id: `${source.id}:${attack.name}:positive`, sourceIndex: source.index, targetIndex: source.index, attack, kind: 'positive', source: source.image, suspect: attackedSource });
      pairs.push({ id: `${source.id}:${attack.name}:easy`, sourceIndex: source.index, targetIndex: easyTarget.index, attack, kind: 'easy', source: source.image, suspect: attackedEasy });
      pairs.push({ id: `${source.id}:${attack.name}:hard`, sourceIndex: source.index, targetIndex: hardTarget.index, attack, kind: 'hard', source: source.image, suspect: attackedHard });
    }
  }
  return pairs;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

async function computeSsim(source: IngestedImage, suspect: IngestedImage): Promise<number> {
  const [first, second] = await Promise.all([
    sharp(source.buffer).resize(64, 64, { fit: 'fill' }).greyscale().raw().toBuffer(),
    sharp(suspect.buffer).resize(64, 64, { fit: 'fill' }).greyscale().raw().toBuffer(),
  ]);
  const sigma = 1.5;
  const weights: number[] = [];
  let weightTotal = 0;
  for (let y = -5; y <= 5; y += 1) for (let x = -5; x <= 5; x += 1) { const weight = Math.exp(-(x * x + y * y) / (2 * sigma * sigma)); weights.push(weight); weightTotal += weight; }
  let total = 0;
  let samples = 0;
  for (let y = 5; y < 59; y += 2) for (let x = 5; x < 59; x += 2) {
    let meanA = 0; let meanB = 0; let varianceA = 0; let varianceB = 0; let covariance = 0; let wi = 0;
    for (let oy = -5; oy <= 5; oy += 1) for (let ox = -5; ox <= 5; ox += 1) { const weight = (weights[wi] ?? 0) / weightTotal; wi += 1; const a = first[(y + oy) * 64 + x + ox] ?? 0; const b = second[(y + oy) * 64 + x + ox] ?? 0; meanA += weight * a; meanB += weight * b; }
    wi = 0;
    for (let oy = -5; oy <= 5; oy += 1) for (let ox = -5; ox <= 5; ox += 1) { const weight = (weights[wi] ?? 0) / weightTotal; wi += 1; const a = first[(y + oy) * 64 + x + ox] ?? 0; const b = second[(y + oy) * 64 + x + ox] ?? 0; varianceA += weight * (a - meanA) ** 2; varianceB += weight * (b - meanB) ** 2; covariance += weight * (a - meanA) * (b - meanB); }
    const c1 = 6.5025; const c2 = 58.5225;
    total += ((2 * meanA * meanB + c1) * (2 * covariance + c2)) / ((meanA ** 2 + meanB ** 2 + c1) * (varianceA + varianceB + c2));
    samples += 1;
  }
  return samples === 0 ? 0 : total / samples;
}

async function colorHistogramCorrelation(source: IngestedImage, suspect: IngestedImage): Promise<number> {
  const [first, second] = await Promise.all([
    sharp(source.buffer).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(suspect.buffer).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  const binsA = new Float64Array(48); const binsB = new Float64Array(48);
  for (let index = 0; index < Math.min(first.data.length, second.data.length); index += 3) {
    for (let channel = 0; channel < 3; channel += 1) {
      const firstBin = channel * 16 + Math.floor((first.data[index + channel] ?? 0) / 16);
      const secondBin = channel * 16 + Math.floor((second.data[index + channel] ?? 0) / 16);
      binsA[firstBin] = (binsA[firstBin] ?? 0) + 1;
      binsB[secondBin] = (binsB[secondBin] ?? 0) + 1;
    }
  }
  let meanA = 0; let meanB = 0; for (const value of binsA) meanA += value / binsA.length; for (const value of binsB) meanB += value / binsB.length;
  let numerator = 0; let da = 0; let db = 0;
  for (let index = 0; index < binsA.length; index += 1) { const a = (binsA[index] ?? 0) - meanA; const b = (binsB[index] ?? 0) - meanB; numerator += a * b; da += a * a; db += b * b; }
  return da === 0 || db === 0 ? 0 : Math.max(0, Math.min(1, (numerator / Math.sqrt(da * db) + 1) / 2));
}

async function scorePair(pair: Pair, embedder: ClipEmbedder): Promise<ScoredPair> {
  const hashStarted = performance.now();
  const [sourceHashes, suspectHashes] = await Promise.all([computeHashes(pair.source.buffer), computeHashes(pair.suspect.buffer)]);
  const hashes = compareHashes(sourceHashes, suspectHashes);
  const hashLatency = performance.now() - hashStarted;
  const embeddingStarted = performance.now();
  const embedding = await embedder.compare(pair.source, pair.suspect);
  const embeddingLatency = performance.now() - embeddingStarted;
  const pixelStarted = performance.now();
  const pixel = await analyzeTamper(pair.source, pair.suspect);
  const pixelLatency = performance.now() - pixelStarted;
  const ssimStarted = performance.now();
  const ssim = await computeSsim(pair.source, pair.suspect);
  const ssimLatency = performance.now() - ssimStarted;
  const histogramStarted = performance.now();
  const histogram = await colorHistogramCorrelation(pair.source, pair.suspect);
  const histogramLatency = performance.now() - histogramStarted;
  const embeddingScore = calculateEmbeddingScore(embedding?.cosine ?? null) ?? 0;
  const pixelScore = calculatePixelScore(pixel.changedFraction);
  const fullStarted = performance.now();
  const full = fuseLayers({ exact: exactMatch(pair.source.originalBytes, pair.suspect.originalBytes), phashDistance: hashes.phashDistance, dhashDistance: hashes.dhashDistance, embeddingCosine: embedding?.cosine ?? null, changedFraction: pixel.changedFraction, regions: pixel.regions });
  const fullLatency = performance.now() - fullStarted;
  return { ...pair, layers: { hash: full.hashScore, embedding: embeddingScore, pixel: pixelScore, phash: 1 - hashes.phashDistance / 64, ssim, histogram, fusion: full.similarity }, latency: { hash: hashLatency, embedding: embeddingLatency, pixel: pixelLatency, ssim: ssimLatency, histogram: histogramLatency, full: fullLatency } };
}

function methodScore(record: ScoredPair, method: MethodName, model?: number[]): number {
  if (method === 'fusion') return record.layers.fusion;
  if (method === 'fusion_fitted' && model) return logistic(model, [record.layers.hash, record.layers.embedding, record.layers.pixel]);
  if (method === 'hash only') return record.layers.hash;
  if (method === 'embedding only') return record.layers.embedding;
  if (method === 'pixel only') return record.layers.pixel;
  if (method === 'hash + embedding') return (record.layers.hash + record.layers.embedding) / 2;
  if (method === 'embedding + pixel') return (record.layers.embedding + record.layers.pixel) / 2;
  if (method === 'pHash Hamming similarity') return record.layers.phash;
  if (method === 'SSIM') return record.layers.ssim;
  return record.layers.histogram;
}

function logistic(model: number[], values: number[]): number {
  let sum = model[0] ?? 0;
  for (let index = 0; index < values.length; index += 1) sum += (model[index + 1] ?? 0) * (values[index] ?? 0);
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, sum))));
}

function fitLogistic(records: ScoredPair[]): number[] {
  const model = [0, 0, 0, 0];
  for (let iteration = 0; iteration < 350; iteration += 1) {
    const gradient = [0, 0, 0, 0];
    for (const record of records) {
      const features = [record.layers.hash, record.layers.embedding, record.layers.pixel];
      const prediction = logistic(model, features);
      const target = record.kind === 'positive' ? 1 : 0;
      const error = prediction - target;
      gradient[0] = (gradient[0] ?? 0) + error;
      for (let index = 0; index < features.length; index += 1) gradient[index + 1] = (gradient[index + 1] ?? 0) + error * (features[index] ?? 0);
    }
    for (let index = 0; index < model.length; index += 1) model[index] = (model[index] ?? 0) - 0.18 * (gradient[index] ?? 0) / Math.max(1, records.length);
  }
  return model;
}

function chooseThreshold(values: Observation[]): number {
  const scores = [...new Set(values.map((value) => value.score))].sort((a, b) => a - b);
  const candidates = [0, 0.5, 1, ...scores];
  for (let index = 1; index < scores.length; index += 1) candidates.push(((scores[index - 1] ?? 0) + (scores[index] ?? 0)) / 2);
  let best = 0.5; let accuracy = -1;
  for (const threshold of candidates) { const current = values.filter((value) => (value.score >= threshold) === value.positive).length / Math.max(1, values.length); if (current > accuracy || (current === accuracy && Math.abs(threshold - 0.5) < Math.abs(best - 0.5))) { best = threshold; accuracy = current; } }
  return best;
}

function rocAuc(values: Observation[]): number {
  const positives = values.filter((value) => value.positive); const negatives = values.filter((value) => !value.positive);
  if (positives.length === 0 || negatives.length === 0) return 0;
  let wins = 0; for (const positive of positives) for (const negative of negatives) wins += positive.score > negative.score ? 1 : positive.score === negative.score ? 0.5 : 0;
  return wins / (positives.length * negatives.length);
}

function isPredictedPositive(value: Observation, threshold: number): boolean {
  return value.predictedPositive ?? value.score >= threshold;
}

function metricSet(values: Observation[], threshold: number): MetricSet {
  const tp = values.filter((value) => value.positive && isPredictedPositive(value, threshold)).length;
  const tn = values.filter((value) => !value.positive && !isPredictedPositive(value, threshold)).length;
  const fp = values.filter((value) => !value.positive && isPredictedPositive(value, threshold)).length;
  const fn = values.filter((value) => value.positive && !isPredictedPositive(value, threshold)).length;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp); const recall = tp + fn === 0 ? 0 : tp / (tp + fn); const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  let tprAtOnePercentFpr = 0; const scores = [...new Set(values.map((value) => value.score)), Number.POSITIVE_INFINITY];
  for (const candidate of scores) { const candidateFp = values.filter((value) => !value.positive && value.score >= candidate).length; const candidateTp = values.filter((value) => value.positive && value.score >= candidate).length; const fpr = candidateFp / Math.max(1, values.filter((value) => !value.positive).length); if (fpr <= 0.01) tprAtOnePercentFpr = Math.max(tprAtOnePercentFpr, candidateTp / Math.max(1, values.filter((value) => value.positive).length)); }
  return { count: values.length, positives: values.filter((value) => value.positive).length, negatives: values.filter((value) => !value.positive).length, accuracy: values.length === 0 ? 0 : (tp + tn) / values.length, precision, recall, f1, falsePositiveRate: values.filter((value) => !value.positive).length === 0 ? 0 : fp / values.filter((value) => !value.positive).length, rocAuc: rocAuc(values), tprAtOnePercentFpr };
}

function evaluateMetrics(values: Observation[], threshold: number): MetricSet & { easyNegatives: MetricSet; hardNegatives: MetricSet } {
  const easy = values.filter((value) => value.positive || value.kind === 'easy'); const hard = values.filter((value) => value.positive || value.kind === 'hard');
  return { ...metricSet(values, threshold), easyNegatives: metricSet(easy, threshold), hardNegatives: metricSet(hard, threshold) };
}

function attackMetrics(values: Observation[], threshold: number): { perAttack: AttackMetric[]; perCategory: CategoryMetric[] } {
  const perAttack = ATTACKS.map((attack) => { const matching = values.filter((value) => value.positive && value.attack === attack.name); return { attack: attack.name, category: attack.category, count: matching.length, truePositiveRate: matching.filter((value) => isPredictedPositive(value, threshold)).length / Math.max(1, matching.length) }; });
  const categories = [...new Set(ATTACKS.map((attack) => attack.category))];
  return { perAttack, perCategory: categories.map((category) => { const attacks = perAttack.filter((attack) => attack.category === category); return { category, truePositiveRate: attacks.reduce((sum, attack) => sum + attack.truePositiveRate, 0) / Math.max(1, attacks.length) }; }) };
}

function rocPoints(values: Observation[]): Array<{ fpr: number; tpr: number }> { const thresholds = [...new Set(values.map((value) => value.score))].sort((a, b) => b - a); const negatives = Math.max(1, values.filter((value) => !value.positive).length); const positives = Math.max(1, values.filter((value) => value.positive).length); return [{ fpr: 0, tpr: 0 }, ...thresholds.map((threshold) => ({ fpr: values.filter((value) => !value.positive && value.score >= threshold).length / negatives, tpr: values.filter((value) => value.positive && value.score >= threshold).length / positives })), { fpr: 1, tpr: 1 }]; }

function latency(values: number[]): LatencySummary { return { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) }; }

function markdownTable(methods: MethodResult[]): string {
  return [
    '| Method | Accuracy | Precision | Recall | F1 | FPR | ROC AUC | TPR @ 1% FPR |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...methods.map((method) => `| ${method.name} | ${(method.heldOut.accuracy * 100).toFixed(2)}% | ${(method.heldOut.precision * 100).toFixed(2)}% | ${(method.heldOut.recall * 100).toFixed(2)}% | ${(method.heldOut.f1 * 100).toFixed(2)}% | ${(method.heldOut.falsePositiveRate * 100).toFixed(2)}% | ${method.heldOut.rocAuc.toFixed(3)} | ${(method.heldOut.tprAtOnePercentFpr * 100).toFixed(2)}% |`),
  ].join('\n');
}

async function writeMarkdown(results: BenchmarkResults): Promise<void> {
  const fusion = results.methods.find((method) => method.name === 'fusion');
  const best = [...results.methods].sort((first, second) => second.heldOut.accuracy - first.heldOut.accuracy)[0];
  const summary = best && fusion
    ? `On the held-out folds, **${best.name}** has the highest accuracy at ${(best.heldOut.accuracy * 100).toFixed(2)}%; the shipped fusion scores ${(fusion.heldOut.accuracy * 100).toFixed(2)}%.`
    : 'No benchmark result is available.';
  const markdown = `# Benchmark results\n\nGenerated from ${results.config.imageCount} images and ${results.config.positivePairs + results.config.easyNegativePairs + results.config.hardNegativePairs} pairs with seed ${results.config.seed}. Headline metrics are two-fold cross-validated by source image; in-sample metrics are reported separately in the JSON.\n\n## Held-out headline results\n\n${markdownTable(results.methods)}\n\n## Where this run wins and loses\n\n${summary}\n\n## Reproduce\n\n\`pnpm bench:data\` downloads and verifies the COCO inputs. Then run \`pnpm bench\` for the full benchmark or \`pnpm bench:quick\` for the offline starter check.\n`;
  await writeFile(RESULTS_MD, markdown, 'utf8');
}

function makeObservation(record: ScoredPair, method: MethodName, model?: number[], predictedPositive?: boolean): Observation {
  const score = methodScore(record, method, model);
  return {
    pairId: record.id,
    sourceIndex: record.sourceIndex,
    attack: record.attack.name,
    category: record.attack.category,
    kind: record.kind,
    positive: record.kind === 'positive',
    score,
    ...(predictedPositive === undefined ? {} : { predictedPositive }),
    latencyMs: record.latency.full,
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const output = [...items];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = output[index];
    output[index] = output[swapIndex] as T;
    output[swapIndex] = current as T;
  }
  return output;
}

async function main(): Promise<void> {
  const images = await loadImages(QUICK);
  const pairs = await createPairs(images);
  const embedder = new ClipEmbedder();
  if (!QUICK) await embedder.initialize();
  console.log(`Scoring ${pairs.length} pairs (${images.length} images × ${ATTACKS.length} attacks × positive/easy/hard). CLIP ready: ${embedder.modelReady}`);

  const records: ScoredPair[] = [];
  for (const pair of pairs) records.push(await scorePair(pair, embedder));

  const foldOrder = shuffle(images.map((image) => image.index), seededRandom(SEED));
  const fold = new Map<number, number>();
  foldOrder.forEach((index, position) => fold.set(index, position < Math.ceil(images.length / 2) ? 0 : 1));
  const methods: MethodResult[] = [];

  for (const method of METHOD_NAMES) {
    const heldOut: Observation[] = [];
    const thresholds: number[] = [];
    let fittedWeights: number[] | undefined;
    for (let heldFold = 0; heldFold < 2; heldFold += 1) {
      const training = records.filter((record) => fold.get(record.sourceIndex) !== heldFold);
      const testing = records.filter((record) => fold.get(record.sourceIndex) === heldFold);
      const model = method === 'fusion_fitted' ? fitLogistic(training) : undefined;
      if (model) fittedWeights = model;
      const trainingObservations = training.map((record) => makeObservation(record, method, model));
      const threshold = chooseThreshold(trainingObservations);
      thresholds.push(threshold);
      for (const record of testing) {
        const score = methodScore(record, method, model);
        heldOut.push(makeObservation(record, method, model, score >= threshold));
      }
    }

    const allModel = method === 'fusion_fitted' ? fitLogistic(records) : undefined;
    const allObservations = records.map((record) => makeObservation(record, method, allModel));
    const inSampleThreshold = chooseThreshold(allObservations);
    const heldThreshold = thresholds.reduce((sum, threshold) => sum + threshold, 0) / Math.max(1, thresholds.length);
    const attack = attackMetrics(heldOut, heldThreshold);
    methods.push({
      name: method,
      threshold: heldThreshold,
      heldOut: evaluateMetrics(heldOut, heldThreshold),
      inSample: evaluateMetrics(allObservations, inSampleThreshold),
      ...attack,
      roc: rocPoints(heldOut),
      latency: latency(records.slice(0, 100).map((record) => record.latency.full)),
      ...(fittedWeights ? { fittedWeights } : {}),
    });
  }

  const fusion = methods.find((method) => method.name === 'fusion');
  const fusionHeldOut: Observation[] = [];
  for (let heldFold = 0; heldFold < 2; heldFold += 1) {
    const training = records.filter((record) => fold.get(record.sourceIndex) !== heldFold);
    const testing = records.filter((record) => fold.get(record.sourceIndex) === heldFold);
    const threshold = chooseThreshold(training.map((record) => makeObservation(record, 'fusion')));
    for (const record of testing) {
      const score = methodScore(record, 'fusion');
      fusionHeldOut.push(makeObservation(record, 'fusion', undefined, score >= threshold));
    }
  }
  const confusion = {
    threshold: fusion?.threshold ?? 0.5,
    truePositive: fusionHeldOut.filter((item) => item.positive && item.predictedPositive).length,
    falsePositive: fusionHeldOut.filter((item) => !item.positive && item.predictedPositive).length,
    trueNegative: fusionHeldOut.filter((item) => !item.positive && !item.predictedPositive).length,
    falseNegative: fusionHeldOut.filter((item) => item.positive && !item.predictedPositive).length,
  };
  const fusionAll = records.map((record) => methodScore(record, 'fusion'));
  const results: BenchmarkResults = {
    config: {
      seed: SEED,
      quick: QUICK,
      attackCount: ATTACKS.length,
      imageCount: images.length,
      positivePairs: pairs.filter((pair) => pair.kind === 'positive').length,
      easyNegativePairs: pairs.filter((pair) => pair.kind === 'easy').length,
      hardNegativePairs: pairs.filter((pair) => pair.kind === 'hard').length,
      methods: METHOD_NAMES,
      crossValidation: 'two folds split by source image',
    },
    versions: { node: process.version, cpu: cpus()[0]?.model ?? 'unknown', sharp: sharp.versions.sharp ?? 'unknown', modelReady: embedder.modelReady },
    attacks: ATTACKS,
    layers: {
      hash: latency(records.slice(0, 100).map((record) => record.latency.hash)),
      embedding: latency(records.slice(0, 100).map((record) => record.latency.embedding)),
      pixel: latency(records.slice(0, 100).map((record) => record.latency.pixel)),
      ssim: latency(records.slice(0, 100).map((record) => record.latency.ssim)),
      histogram: latency(records.slice(0, 100).map((record) => record.latency.histogram)),
    },
    methods,
    confusionMatrix: confusion,
    scoreDistribution: {
      positive: fusionAll.filter((_, index) => records[index]?.kind === 'positive'),
      negative: fusionAll.filter((_, index) => records[index]?.kind !== 'positive'),
    },
  };
  await writeFile(RESULTS_JSON, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  await writeMarkdown(results);
  await writeCharts(results, CHART_DIR);
  console.table(methods.map((method) => ({ method: method.name, accuracy: `${(method.heldOut.accuracy * 100).toFixed(2)}%`, f1: `${(method.heldOut.f1 * 100).toFixed(2)}%`, fpr: `${(method.heldOut.falsePositiveRate * 100).toFixed(2)}%`, auc: method.heldOut.rocAuc.toFixed(3) })));
  console.log(`Charts written to ${path.relative(ROOT, CHART_DIR)}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
