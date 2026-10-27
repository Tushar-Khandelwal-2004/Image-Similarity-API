import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

interface CocoEntry {
  id: string;
  sha256: string | null;
}

interface CocoIndex {
  source: string;
  ids: CocoEntry[];
}

const ROOT = path.resolve(process.cwd());
const INDEX_PATH = path.join(ROOT, 'bench', 'coco_ids.json');
const IMAGE_DIR = path.join(ROOT, 'bench', 'coco_images');

function checksum(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function downloadImage(entry: CocoEntry, source: string): Promise<CocoEntry> {
  const filename = `${entry.id}.jpg`;
  const target = path.join(IMAGE_DIR, filename);
  let bytes: Buffer;
  try {
    bytes = await readFile(target);
    await sharp(bytes).metadata();
  } catch {
    let response: Response;
    try {
      response = await fetch(`${source}/${filename}`);
    } catch {
      response = await fetch(`${source.replace('https://', 'http://')}/${filename}`);
    }
    if (!response.ok) {
      throw new Error(`COCO download failed for ${entry.id}: HTTP ${response.status}`);
    }
    bytes = Buffer.from(await response.arrayBuffer());
    await sharp(bytes).jpeg().toBuffer();
    await writeFile(target, bytes);
  }
  const sha256 = checksum(bytes);
  console.log(`${entry.id}: ${sha256}`);
  return { id: entry.id, sha256 };
}

async function main(): Promise<void> {
  const index = JSON.parse(await readFile(INDEX_PATH, 'utf8')) as CocoIndex;
  if (index.ids.length !== 30) {
    throw new Error(`Expected exactly 30 COCO IDs, found ${index.ids.length}.`);
  }
  await mkdir(IMAGE_DIR, { recursive: true });
  const updated = await Promise.all(index.ids.map((entry) => downloadImage(entry, index.source)));
  await writeFile(INDEX_PATH, `${JSON.stringify({ ...index, ids: updated }, null, 2)}\n`, 'utf8');
  console.log(`Downloaded and verified ${updated.length} COCO val2017 images.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
