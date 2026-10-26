import sharp from 'sharp';
import { sha256 } from './exact.js';
import { AppError, type IngestedImage, type NormalizedImage } from '../types.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 40_000_000;
export const MAX_NORMALIZED_SIDE = 512;

const ACCEPTED_FORMATS = new Set<NormalizedImage['format']>(['jpeg', 'png', 'webp']);

function isAcceptedFormat(format: string | undefined): format is NormalizedImage['format'] {
  return format !== undefined && ACCEPTED_FORMATS.has(format as NormalizedImage['format']);
}

export async function normalizeImage(bytes: Buffer): Promise<NormalizedImage> {
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new AppError('FILE_TOO_LARGE', 'Each image must be 10 MB or smaller.', 413);
  }

  const input = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS });
  let metadata: sharp.Metadata;
  try {
    metadata = await input.metadata();
  } catch {
    throw new AppError('INVALID_IMAGE', 'The uploaded file is not a readable image.', 400);
  }

  if (!isAcceptedFormat(metadata.format) || !metadata.width || !metadata.height) {
    throw new AppError('INVALID_IMAGE', 'Only JPEG, PNG, and WebP images are accepted.', 400);
  }

  try {
    const normalized = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .toColorspace('srgb')
      .resize({
        width: MAX_NORMALIZED_SIDE,
        height: MAX_NORMALIZED_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer({ resolveWithObject: true });

    return {
      buffer: normalized.data,
      size: {
        width: normalized.info.width,
        height: normalized.info.height,
      },
      format: 'png',
    };
  } catch {
    throw new AppError('INVALID_IMAGE', 'The uploaded file could not be normalized.', 400);
  }
}

export async function ingestImage(bytes: Buffer): Promise<IngestedImage> {
  const normalized = await normalizeImage(bytes);
  return {
    ...normalized,
    originalBytes: bytes,
    sha256: sha256(bytes),
  };
}
