import sharp from 'sharp';

import { logger } from '../logger.js';

// Keep below Anthropic's many-image dimension cap (2000px) with headroom.
// Applied only when the input exceeds this on either dimension.
const MAX_IMAGE_DIMENSION = 1800;

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.heic',
  '.heif',
  '.bmp',
  '.tif',
  '.tiff',
]);

/**
 * When a Telegram document (file upload) is an image, Telegram sends the raw
 * file at native resolution with no client-side compression. A 13 000px-tall
 * landing-page scrollshot lands on disk unchanged, then fails the API's
 * 2000px cap for many-image requests the moment the session accumulates a
 * second image.
 *
 * Photos uploaded via the "send as image" path are already compressed by
 * Telegram (≤1280px typically), so they do not need this treatment.
 *
 * This helper checks the filename's extension, and only if it looks like an
 * image does it pass the buffer through sharp. Non-image documents are
 * returned unchanged. If sharp cannot decode the buffer (corrupt image,
 * unsupported format), the original buffer is returned so the download
 * still succeeds — the agent can decide what to do with it.
 */
export async function maybeResizeImage(
  buffer: Buffer,
  filename: string,
): Promise<Buffer> {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return buffer;

  try {
    const meta = await sharp(buffer).metadata();
    const maxDim = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (maxDim === 0) return buffer; // sharp could not determine size
    if (maxDim <= MAX_IMAGE_DIMENSION) return buffer; // already small enough

    return await sharp(buffer)
      .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toBuffer();
  } catch (err) {
    logger.warn(
      { filename, err },
      'Telegram image resize failed, writing original buffer',
    );
    return buffer;
  }
}
