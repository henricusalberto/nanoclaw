import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { maybeResizeImage } from './telegram-media.js';

async function createPng(width: number, height: number): Promise<Buffer> {
  // Solid-color PNG of the given size, no enlargement tricks.
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 120, g: 80, b: 200 },
    },
  })
    .png()
    .toBuffer();
}

describe('maybeResizeImage', () => {
  it('returns the original buffer unchanged for non-image filenames', async () => {
    const buffer = Buffer.from('this is not an image');
    const result = await maybeResizeImage(buffer, 'notes.pdf');
    expect(result).toBe(buffer);
  });

  it('returns the original buffer unchanged for small images', async () => {
    const buffer = await createPng(800, 600);
    const result = await maybeResizeImage(buffer, 'small.png');
    expect(result).toBe(buffer);
  });

  it('resizes a tall landing-page scrollshot so the long edge is at most 1800px', async () => {
    // Mimic the real offender: 1265 × 13048 scrollshot. Test a smaller tall
    // image for speed but with the same aspect-ratio shape.
    const buffer = await createPng(400, 4000);
    const result = await maybeResizeImage(buffer, 'nightcap-lp-full.png');

    expect(result).not.toBe(buffer);
    const meta = await sharp(result).metadata();
    expect(meta.height).toBeLessThanOrEqual(1800);
    expect(meta.width).toBeLessThanOrEqual(1800);
    // Aspect ratio preserved (fit: 'inside')
    const maxDim = Math.max(meta.width ?? 0, meta.height ?? 0);
    expect(maxDim).toBeLessThanOrEqual(1800);
    expect(maxDim).toBeGreaterThanOrEqual(1700); // was scaled down to near the cap
  });

  it('resizes a wide image in the same way', async () => {
    const buffer = await createPng(4000, 400);
    const result = await maybeResizeImage(buffer, 'wide.jpeg');
    const meta = await sharp(result).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(
      1800,
    );
  });

  it('recognises image extensions case-insensitively', async () => {
    const buffer = await createPng(3000, 3000);
    const result = await maybeResizeImage(buffer, 'SCREEN.PNG');
    const meta = await sharp(result).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(
      1800,
    );
  });

  it('falls back to the original buffer when sharp cannot decode', async () => {
    const garbage = Buffer.from('not a real png, just bytes');
    const result = await maybeResizeImage(garbage, 'corrupt.png');
    expect(result).toBe(garbage);
  });
});
