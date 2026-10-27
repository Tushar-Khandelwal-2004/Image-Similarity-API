import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface MetricSet {
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  falsePositiveRate: number;
  rocAuc: number;
  tprAtOnePercentFpr: number;
}

interface MethodResult {
  name: string;
  heldOut: MetricSet & { easyNegatives: MetricSet; hardNegatives: MetricSet };
  inSample: MetricSet & { easyNegatives: MetricSet; hardNegatives: MetricSet };
  perAttack: Array<{ attack: string; category: string; truePositiveRate: number }>;
  perCategory: Array<{ category: string; truePositiveRate: number }>;
}

interface Results {
  config: { seed: number; imageCount: number; positivePairs: number; easyNegativePairs: number; hardNegativePairs: number };
  versions: { node: string; cpu: string; sharp: string; modelReady: boolean };
  attacks: Array<{ name: string; category: string }>;
  methods: MethodResult[];
  layers: Record<string, { p50: number; p95: number }>;
}

const root = path.resolve(process.cwd());
const readmePath = path.join(root, 'README.md');
const resultsPath = path.join(root, 'bench', 'results.json');
const startMarker = '<!-- BENCHMARK_RESULTS_START -->';
const endMarker = '<!-- BENCHMARK_RESULTS_END -->';

function percent(value: number): string { return `${(value * 100).toFixed(2)}%`; }
function metricRow(method: MethodResult, metrics: MetricSet): string { return `| ${method.name} | ${percent(metrics.accuracy)} | ${percent(metrics.precision)} | ${percent(metrics.recall)} | ${percent(metrics.f1)} | ${percent(metrics.falsePositiveRate)} | ${metrics.rocAuc.toFixed(3)} | ${percent(metrics.tprAtOnePercentFpr)} |`; }

function benchmarkSection(results: Results): string {
  const fusion = results.methods.find((method) => method.name === 'fusion');
  const fitted = results.methods.find((method) => method.name === 'fusion_fitted');
  const best = [...results.methods].sort((first, second) => second.heldOut.accuracy - first.heldOut.accuracy)[0];
  const winLoss = best && fusion
    ? `The best held-out accuracy in this run is **${best.name}** at ${percent(best.heldOut.accuracy)}; shipped hand-tuned fusion is ${percent(fusion.heldOut.accuracy)}. Fusion's false-positive rate is ${percent(fusion.heldOut.falsePositiveRate)} and its ROC AUC is ${fusion.heldOut.rocAuc.toFixed(3)}. `
      + (fitted && fitted.heldOut.accuracy > fusion.heldOut.accuracy
        ? `Fitted fusion beats shipped fusion on held-out accuracy, so the shipped weights should be reviewed before the next release.`
        : `Fitted fusion does not beat shipped fusion on held-out accuracy in this run, so the shipped default weights remain unchanged.`)
    : 'The benchmark did not produce comparable fusion results.';
  const headline = [
    '| Method | Accuracy | Precision | Recall | F1 | FPR | ROC AUC | TPR @ 1% FPR |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...results.methods.map((method) => metricRow(method, method.heldOut)),
  ].join('\n');
  const easyHard = [
    '| Method | Easy accuracy | Hard accuracy | Easy FPR | Hard FPR |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...results.methods.map((method) => `| ${method.name} | ${percent(method.heldOut.easyNegatives.accuracy)} | ${percent(method.heldOut.hardNegatives.accuracy)} | ${percent(method.heldOut.easyNegatives.falsePositiveRate)} | ${percent(method.heldOut.hardNegatives.falsePositiveRate)} |`),
  ].join('\n');
  const category = [
    '| Method | ' + results.methods[0]?.perCategory.map((item) => item.category).join(' | ') + ' |',
    '| --- | ' + results.methods[0]?.perCategory.map(() => '---:').join(' | ') + ' |',
    ...results.methods.map((method) => `| ${method.name} | ${method.perCategory.map((item) => percent(item.truePositiveRate)).join(' | ')} |`),
  ].join('\n');
  const attackRows = fusion?.perAttack.map((attack) => `| ${attack.attack} | ${attack.category} | ${percent(attack.truePositiveRate)} |`).join('\n') ?? '';
  const layerRows = Object.entries(results.layers).map(([name, value]) => `| ${name} | ${value.p50.toFixed(2)} | ${value.p95.toFixed(2)} |`).join('\n');
  const attackList = results.attacks.map((attack) => `| ${attack.name} | ${attack.category} |`).join('\n');
  return `${startMarker}
### Dataset and run

- Images: ${results.config.imageCount}
- Positive pairs: ${results.config.positivePairs}
- Easy negatives: ${results.config.easyNegativePairs}
- Hard negatives: ${results.config.hardNegativePairs}
- Seed: ${results.config.seed}
- Runtime: ${results.versions.node}, Sharp ${results.versions.sharp}, ${results.versions.cpu}

Headline metrics are two-fold cross-validated by source image. Thresholds and fitted logistic weights are trained only on each training fold before the held-out fold is scored. The separate in-sample table is intentionally not the headline result.

#### Held-out headline metrics

${headline}

#### Easy and hard negative splits

${easyHard}

#### In-sample reference metrics

| Method | Accuracy | Precision | Recall | F1 | FPR | ROC AUC | TPR @ 1% FPR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${results.methods.map((method) => metricRow(method, method.inSample)).join('\n')}

#### Recall by category for every method

${category}

#### Shipped fusion true-positive rate by attack

| Attack | Category | TPR |
| --- | --- | ---: |
${attackRows}

#### Attack definitions

| Attack | Category |
| --- | --- |
${attackList}

#### Layer latency over the first 100 warm pairs

| Layer | p50 ms | p95 ms |
| --- | ---: | ---: |
${layerRows}

#### Charts

![ROC curves](docs/benchmarks/roc.svg)

![Accuracy and F1](docs/benchmarks/accuracy.svg)

![Per-attack heatmap](docs/benchmarks/per_attack_heatmap.svg)

![Per-category recall](docs/benchmarks/per_category.svg)

![Score distribution](docs/benchmarks/score_distribution.svg)

![Confusion matrix](docs/benchmarks/confusion_matrix.svg)

![Ablation](docs/benchmarks/ablation.svg)

![Latency](docs/benchmarks/latency.svg)

#### Where we win and where we lose

${winLoss} The full raw result, including every method's per-attack metrics and fold details, is in [bench/results.json](bench/results.json).
${endMarker}`;
}

async function main(): Promise<void> {
  const [readme, rawResults] = await Promise.all([readFile(readmePath, 'utf8'), readFile(resultsPath, 'utf8')]);
  const results = JSON.parse(rawResults) as Results;
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);
  if (start < 0 || end < start) throw new Error('README benchmark markers are missing or out of order.');
  const updated = `${readme.slice(0, start)}${benchmarkSection(results)}${readme.slice(end + endMarker.length)}`;
  await writeFile(readmePath, updated, 'utf8');
  console.log('Injected benchmark results into README.md.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
