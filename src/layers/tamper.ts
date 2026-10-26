import sharp from 'sharp';
import type { ImageSize, IngestedImage, Region } from '../types.js';

export const DIFFERENCE_THRESHOLD = 40;
export const MIN_REGION_FRACTION = 0.005;
export const MAX_REGIONS = 5;

export interface DifferenceMap {
  width: number;
  height: number;
  strengths: Uint8Array;
  mask: Uint8Array;
}

export interface TamperResult {
  regions: Region[];
  changedFraction: number;
  heatmapPng: Buffer;
}

interface GrayscaleImage {
  data: Buffer;
  size: ImageSize;
}

async function grayscaleBlurred(buffer: Buffer, width: number, height: number): Promise<GrayscaleImage> {
  const result = await sharp(buffer)
    .resize(width, height, { fit: 'fill' })
    .greyscale()
    .blur(1.5)
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data: result.data,
    size: {
      width: result.info.width,
      height: result.info.height,
    },
  };
}

export function computeDifferenceMap(
  source: Uint8Array,
  suspect: Uint8Array,
  width: number,
  height: number,
  threshold = DIFFERENCE_THRESHOLD,
): DifferenceMap {
  const pixelCount = width * height;
  if (source.length < pixelCount || suspect.length < pixelCount) {
    throw new Error('Difference inputs are smaller than the declared image size.');
  }

  const rawDifferences = new Uint8Array(pixelCount);
  let maximumDifference = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    const difference = Math.abs((source[index] ?? 0) - (suspect[index] ?? 0));
    rawDifferences[index] = difference;
    maximumDifference = Math.max(maximumDifference, difference);
  }

  const strengths = new Uint8Array(pixelCount);
  const mask = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const strength = maximumDifference === 0
      ? 0
      : Math.round(((rawDifferences[index] ?? 0) / maximumDifference) * 255);
    strengths[index] = strength;
    if (strength >= threshold) {
      mask[index] = 1;
    }
  }

  const cleanedMask = erodeMask(dilateMask(mask, width, height), width, height);
  return {
    width,
    height,
    strengths,
    mask: cleanedMask,
  };
}

export function dilateMask(mask: Uint8Array, width: number, height: number): Uint8Array {
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let on = false;
      for (let offsetY = -1; offsetY <= 1 && !on; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const neighborX = x + offsetX;
          const neighborY = y + offsetY;
          if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) {
            continue;
          }
          if (mask[neighborY * width + neighborX] === 1) {
            on = true;
            break;
          }
        }
      }
      output[y * width + x] = on ? 1 : 0;
    }
  }
  return output;
}

export function erodeMask(mask: Uint8Array, width: number, height: number): Uint8Array {
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let on = true;
      for (let offsetY = -1; offsetY <= 1 && on; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const neighborX = x + offsetX;
          const neighborY = y + offsetY;
          if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height
            || mask[neighborY * width + neighborX] !== 1) {
            on = false;
            break;
          }
        }
      }
      output[y * width + x] = on ? 1 : 0;
    }
  }
  return output;
}

export function findRegions(mask: Uint8Array, width: number, height: number): Region[] {
  const visited = new Uint8Array(mask.length);
  const minimumArea = Math.max(1, Math.ceil(width * height * MIN_REGION_FRACTION));
  const regions: Array<Region & { area: number }> = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const startIndex = y * width + x;
      if (mask[startIndex] !== 1 || visited[startIndex] === 1) {
        continue;
      }

      const queue: Array<[number, number]> = [[x, y]];
      visited[startIndex] = 1;
      let head = 0;
      let area = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;

      while (head < queue.length) {
        const current = queue[head];
        head += 1;
        if (!current) {
          continue;
        }
        const [currentX, currentY] = current;
        area += 1;
        minX = Math.min(minX, currentX);
        maxX = Math.max(maxX, currentX);
        minY = Math.min(minY, currentY);
        maxY = Math.max(maxY, currentY);

        const neighbors: Array<[number, number]> = [
          [currentX - 1, currentY],
          [currentX + 1, currentY],
          [currentX, currentY - 1],
          [currentX, currentY + 1],
        ];
        for (const [neighborX, neighborY] of neighbors) {
          if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) {
            continue;
          }
          const neighborIndex = neighborY * width + neighborX;
          if (mask[neighborIndex] === 1 && visited[neighborIndex] === 0) {
            visited[neighborIndex] = 1;
            queue.push([neighborX, neighborY]);
          }
        }
      }

      if (area >= minimumArea) {
        regions.push({
          x: minX,
          y: minY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
          area,
        });
      }
    }
  }

  return regions
    .sort((first, second) => second.area - first.area)
    .slice(0, MAX_REGIONS)
    .map(({ area: _area, ...region }) => region);
}

function changedFraction(mask: Uint8Array): number {
  let changedPixels = 0;
  for (const value of mask) {
    changedPixels += value;
  }
  return mask.length === 0 ? 0 : changedPixels / mask.length;
}

async function buildHeatmapOverlay(map: DifferenceMap): Promise<Buffer> {
  const rgba = new Uint8Array(map.width * map.height * 4);
  for (let index = 0; index < map.width * map.height; index += 1) {
    const rgbaIndex = index * 4;
    rgba[rgbaIndex] = 255;
    rgba[rgbaIndex + 1] = 0;
    rgba[rgbaIndex + 2] = 0;
    rgba[rgbaIndex + 3] = map.strengths[index] ?? 0;
  }

  return sharp(Buffer.from(rgba), {
    raw: {
      width: map.width,
      height: map.height,
      channels: 4,
    },
  }).png().toBuffer();
}

function scaleRegions(regions: Region[], from: ImageSize, to: ImageSize): Region[] {
  const scaleX = to.width / from.width;
  const scaleY = to.height / from.height;
  return regions.map((region) => ({
    x: Math.max(0, Math.round(region.x * scaleX)),
    y: Math.max(0, Math.round(region.y * scaleY)),
    width: Math.max(1, Math.round(region.width * scaleX)),
    height: Math.max(1, Math.round(region.height * scaleY)),
  }));
}

export async function analyzeTamper(source: IngestedImage, suspect: IngestedImage): Promise<TamperResult> {
  const targetSize = source.size;
  const [sourceGray, suspectGray] = await Promise.all([
    grayscaleBlurred(source.buffer, targetSize.width, targetSize.height),
    grayscaleBlurred(suspect.buffer, targetSize.width, targetSize.height),
  ]);
  const map = computeDifferenceMap(
    sourceGray.data,
    suspectGray.data,
    targetSize.width,
    targetSize.height,
  );
  const targetRegions = findRegions(map.mask, map.width, map.height);
  const heatmap = await buildHeatmapOverlay(map);
  const resizedHeatmap = source.size.width === suspect.size.width && source.size.height === suspect.size.height
    ? heatmap
    : await sharp(heatmap).resize(suspect.size.width, suspect.size.height, { fit: 'fill' }).png().toBuffer();
  const heatmapPng = await sharp(suspect.buffer)
    .composite([{ input: resizedHeatmap, blend: 'over' }])
    .png()
    .toBuffer();

  return {
    regions: scaleRegions(targetRegions, targetSize, suspect.size),
    changedFraction: changedFraction(map.mask),
    heatmapPng,
  };
}
