import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ChartMethod {
  name: string;
  heldOut: { accuracy: number; f1: number; rocAuc: number };
  threshold: number;
  roc: Array<{ fpr: number; tpr: number }>;
  perAttack: Array<{ attack: string; truePositiveRate: number }>;
  perCategory: Array<{ category: string; truePositiveRate: number }>;
  latency: { p50: number; p95: number };
}

export interface ChartResults {
  methods: ChartMethod[];
  attacks: Array<{ name: string }>;
  confusionMatrix: { truePositive: number; falsePositive: number; trueNegative: number; falseNegative: number };
  scoreDistribution: { positive: number[]; negative: number[] };
}

function text(value: string, x: number, y: number, size = 13, color = '#667085'): string {
  return `<text x="${x}" y="${y}" font-family="Arial,sans-serif" font-size="${size}" fill="${color}">${value}</text>`;
}

function panel(title: string, body: string, width = 1000, height = 560): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}"><rect width="${width}" height="${height}" rx="26" fill="white"/><text x="44" y="52" font-family="Arial,sans-serif" font-size="25" font-weight="700" fill="#172033">${title}</text>${body}</svg>`;
}

function barChart(title: string, labels: string[], first: number[], second: number[] | null, secondLabel: string): string {
  const left = 220;
  const chartWidth = 680;
  const rowHeight = 42;
  const body = labels.map((label, index) => {
    const y = 90 + index * rowHeight;
    const firstWidth = (first[index] ?? 0) * chartWidth;
    const secondWidth = second ? (second[index] ?? 0) * chartWidth : 0;
    return `${text(label, 38, y + 15, 12, '#172033')}<rect x="${left}" y="${y}" width="${firstWidth}" height="17" rx="8" fill="#3158d4"/>${second ? `<rect x="${left}" y="${y + 21}" width="${secondWidth}" height="17" rx="8" fill="#8b5cf6"/>` : ''}`;
  }).join('');
  const height = Math.max(560, 140 + labels.length * rowHeight);
  const legend = second ? `${text('■ p50', 770, height - 28, 13, '#3158d4')}${text(`■ ${secondLabel}`, 850, height - 28, 13, '#8b5cf6')}` : '';
  return panel(title, `${text('0', left, height - 50)}${text('1.0', left + chartWidth - 20, height - 50)}${legend}${body}`, 1000, height);
}

function scoreHistogram(results: ChartResults): string {
  const bins = 20;
  const positive = Array.from({ length: bins }, () => 0);
  const negative = Array.from({ length: bins }, () => 0);
  for (const score of results.scoreDistribution.positive) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(score * bins)));
    positive[index] = (positive[index] ?? 0) + 1;
  }
  for (const score of results.scoreDistribution.negative) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(score * bins)));
    negative[index] = (negative[index] ?? 0) + 1;
  }
  const maximum = Math.max(1, ...positive, ...negative);
  const threshold = results.methods.find((method) => method.name === 'fusion')?.threshold ?? 0.5;
  const bars = positive.map((value, index) => {
    const x = 70 + index * 42;
    const positiveHeight = value / maximum * 340;
    const negativeHeight = (negative[index] ?? 0) / maximum * 340;
    return `<rect x="${x}" y="${460 - positiveHeight}" width="18" height="${positiveHeight}" fill="#3158d4"/><rect x="${x + 19}" y="${460 - negativeHeight}" width="18" height="${negativeHeight}" fill="#d9485f"/>`;
  }).join('');
  return panel('Fusion score distribution', `${text('score', 485, 535)}${text('count', 15, 290)}<line x1="70" y1="460" x2="910" y2="460" stroke="#cbd5e1"/><line x1="${70 + threshold * 840}" y1="90" x2="${70 + threshold * 840}" y2="460" stroke="#172033" stroke-width="3" stroke-dasharray="8 6"/>${text(`threshold ${threshold.toFixed(3)}`, 720, 112, 13, '#172033')}${text('■ positives', 700, 145, 13, '#3158d4')}${text('■ negatives', 700, 168, 13, '#d9485f')}${bars}`, 1000, 580);
}

export async function writeCharts(results: ChartResults, directory: string): Promise<void> {
  const methods = results.methods;
  const labels = methods.map((method) => method.name);
  const colors = ['#3158d4', '#8b5cf6', '#0f9f78', '#f59e0b', '#d9485f', '#475569', '#a855f7', '#14b8a6', '#fb7185', '#64748b'];
  const rocPaths = methods.map((method, index) => `<path d="${method.roc.map((point, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'} ${60 + point.fpr * 820} ${480 - point.tpr * 390}`).join(' ')}" fill="none" stroke="${colors[index] ?? '#3158d4'}" stroke-width="3"/>${text(`${method.name} AUC ${method.heldOut.rocAuc.toFixed(3)}`, 650, 84 + index * 19, 11, colors[index] ?? '#3158d4')}`).join('');
  const heatmap = methods.map((method, row) => method.perAttack.map((attack, column) => {
    const shade = Math.round(255 - attack.truePositiveRate * 170);
    return `<rect x="${165 + column * 25}" y="${88 + row * 30}" width="22" height="27" rx="4" fill="rgb(${shade},${Math.round(shade + attack.truePositiveRate * 20)},${255 - Math.round(attack.truePositiveRate * 130)})"/>${text(`${Math.round(attack.truePositiveRate * 100)}`, 169 + column * 25, 107 + row * 30, 9, attack.truePositiveRate > 0.6 ? 'white' : '#172033')}`;
  }).join('')).join('');
  const categories = methods[0]?.perCategory.map((item) => item.category) ?? [];
  const categoryBars = categories.map((category, categoryIndex) => methods.map((method, methodIndex) => {
    const value = method.perCategory.find((item) => item.category === category)?.truePositiveRate ?? 0;
    return `<rect x="${180 + categoryIndex * 105 + methodIndex * 8}" y="${450 - value * 300}" width="7" height="${value * 300}" fill="${colors[methodIndex] ?? '#3158d4'}"/>`;
  }).join('')).join('');
  const confusion = results.confusionMatrix;
  const charts: Record<string, string> = {
    'roc.svg': panel('ROC curves', `${text('false positive rate', 430, 535)}${text('true positive rate', 18, 280)}<line x1="60" y1="480" x2="880" y2="480" stroke="#cbd5e1"/><line x1="60" y1="90" x2="60" y2="480" stroke="#cbd5e1"/><line x1="60" y1="480" x2="880" y2="90" stroke="#e2e8f0" stroke-dasharray="6 6"/>${rocPaths}`, 1000, 580),
    'accuracy.svg': barChart('Accuracy and F1 by method', labels, methods.map((method) => method.heldOut.accuracy), methods.map((method) => method.heldOut.f1), 'F1'),
    'per_attack_heatmap.svg': panel('True positive rate per attack', `${methods.map((method, index) => text(method.name, 38, 105 + index * 30, 11, '#172033')).join('')}${heatmap}${results.attacks.map((attack, index) => `<text transform="translate(${173 + index * 25},510) rotate(-62)" font-family="Arial" font-size="9" fill="#667085">${attack.name}</text>`).join('')}`, 1000, 580),
    'per_category.svg': panel('Recall by attack category', `${categoryBars}${categories.map((category, index) => `<text transform="translate(${185 + index * 105},500) rotate(-45)" font-family="Arial" font-size="10" fill="#667085">${category}</text>`).join('')}${methods.slice(0, 8).map((method, index) => text(`■ ${method.name}`, 700, 90 + index * 18, 10, colors[index] ?? '#3158d4')).join('')}`, 1000, 560),
    'score_distribution.svg': scoreHistogram(results),
    'confusion_matrix.svg': panel('Fusion confusion matrix (held out)', `<rect x="235" y="160" width="190" height="120" fill="#d9f7ec"/><rect x="425" y="160" width="190" height="120" fill="#ffe4e6"/><rect x="235" y="280" width="190" height="120" fill="#fff2cc"/><rect x="425" y="280" width="190" height="120" fill="#dbeafe"/>${text('predicted positive', 330, 135)}${text('predicted negative', 470, 435)}${text(`TP ${confusion.truePositive}`, 300, 230, 24, '#172033')}${text(`FP ${confusion.falsePositive}`, 490, 230, 24, '#172033')}${text(`FN ${confusion.falseNegative}`, 300, 350, 24, '#172033')}${text(`TN ${confusion.trueNegative}`, 490, 350, 24, '#172033')}`, 1000, 560),
    'ablation.svg': barChart('Ablation accuracy', ['hash only', 'embedding only', 'pixel only', 'hash + embedding', 'embedding + pixel'], methods.filter((method) => ['hash only', 'embedding only', 'pixel only', 'hash + embedding', 'embedding + pixel'].includes(method.name)).map((method) => method.heldOut.accuracy), null, ''),
    'latency.svg': barChart('Latency p50 and p95 by method', labels, methods.map((method) => method.latency.p50 / Math.max(1, ...methods.map((item) => item.latency.p95))), methods.map((method) => method.latency.p95 / Math.max(1, ...methods.map((item) => item.latency.p95))), 'p95'),
  };
  await Promise.all(Object.entries(charts).map(([filename, content]) => writeFile(path.join(directory, filename), content, 'utf8')));
}
