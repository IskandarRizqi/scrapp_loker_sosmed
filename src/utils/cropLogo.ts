import { JobVacancy } from '../types';

export type LogoBox = NonNullable<JobVacancy['logoBox']>;

const MAX_LOGO_SIZE = 256;
const CROP_PADDING_RATIO = 0.1;
const MAX_UPSCALE = 4;

/**
 * Parse the logoBox returned by the AI (already an object, or a JSON string) into
 * a usable bounding box. Returns null when missing/invalid.
 */
export function parseLogoBox(value: JobVacancy['logoBox'] | string | null | undefined): LogoBox | null {
  if (!value) return null;
  if (typeof value !== 'string') {
    return isValidLogoBox(value) ? value : null;
  }
  try {
    const parsed = JSON.parse(value) as LogoBox;
    return isValidLogoBox(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isValidLogoBox(box: LogoBox | Record<string, unknown> | null | undefined): box is LogoBox {
  return (
    !!box &&
    Number.isFinite((box as LogoBox).x) &&
    Number.isFinite((box as LogoBox).y) &&
    Number.isFinite((box as LogoBox).w) &&
    Number.isFinite((box as LogoBox).h) &&
    (box as LogoBox).w > 0 &&
    (box as LogoBox).h > 0
  );
}

function loadImage(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function toPngDataUrl(canvas: HTMLCanvasElement): Promise<string | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    }, 'image/png');
  });
}

/**
 * Downscale any logo image (e.g. a favicon fetched from the company website) so it
 * fits within MAX_LOGO_SIZE px while keeping its aspect ratio. Smaller images are
 * returned unchanged so we never degrade a crisp logo.
 */
export async function normalizeLogoImage(dataUrl: string): Promise<string | null> {
  if (!dataUrl) return null;
  const img = await loadImage(dataUrl);
  if (!img) return null;
  if (img.width <= MAX_LOGO_SIZE && img.height <= MAX_LOGO_SIZE) return dataUrl;

  const scale = MAX_LOGO_SIZE / Math.max(img.width, img.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return toPngDataUrl(canvas);
}

/**
 * Crop the logo area out of an uploaded screenshot (base64 data URL) using the
 * normalized bounding box. Adds a little padding around the detected box, keeps the
 * natural aspect ratio, and scales the result to be clearly visible in the Excel row.
 * Returns null when cropping fails or inputs are invalid.
 */
export async function cropImageToLogo(dataUrl: string, box: LogoBox | null): Promise<string | null> {
  if (!box || !dataUrl) return null;
  const img = await loadImage(dataUrl);
  if (!img) return null;

  try {
    const padX = box.w * img.width * CROP_PADDING_RATIO;
    const padY = box.h * img.height * CROP_PADDING_RATIO;

    let sx = Math.max(0, Math.floor(box.x * img.width - padX));
    let sy = Math.max(0, Math.floor(box.y * img.height - padY));
    let sw = Math.min(img.width - sx, Math.ceil(box.w * img.width + padX * 2));
    let sh = Math.min(img.height - sy, Math.ceil(box.h * img.height + padY * 2));
    sw = Math.max(1, sw);
    sh = Math.max(1, sh);

    const scale = Math.min(MAX_LOGO_SIZE / Math.max(sw, sh), MAX_UPSCALE);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return await toPngDataUrl(canvas);
  } catch {
    return null;
  }
}
