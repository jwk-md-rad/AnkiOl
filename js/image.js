// Foto inlezen, verkleinen en eventueel grijs maken.

// iPhones bewaren foto's als HEIC; Chrome kan dat niet zelf openen.
const HEIC2ANY_URL = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';

export function isHeic(file) {
  return /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name || '');
}

export function isImageFile(file) {
  return /^image\//.test(file.type) || isHeic(file);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Kon de iPhone-foto niet omzetten. Ben je online?'));
    document.head.appendChild(s);
  });
}

async function heicToJpeg(file) {
  if (!window.heic2any) await loadScript(HEIC2ANY_URL);
  const out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  return Array.isArray(out) ? out[0] : out;
}

export async function loadImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (err) {
    if (!isHeic(file)) throw err;
    return createImageBitmap(await heicToJpeg(file));
  }
}

// Foto draaien, eventueel uitsnijden (crop: x, y, w, h als fractie 0–1 van
// de gedraaide foto) en verkleinen tot maxSide pixels.
export function toCanvas(bitmap, maxSide, { grayscale = false, rotate = 0, crop = null } = {}) {
  const W = bitmap.width;
  const H = bitmap.height;
  const swap = rotate % 180 !== 0;
  const rw = swap ? H : W;
  const rh = swap ? W : H;
  const c = crop || { x: 0, y: 0, w: 1, h: 1 };
  const cx = c.x * rw;
  const cy = c.y * rh;
  const cw = c.w * rw;
  const ch = c.h * rh;
  const scale = Math.min(1, maxSide / Math.max(cw, ch));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cw * scale));
  canvas.height = Math.max(1, Math.round(ch * scale));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);
  // Draaien in hele pixels (geen halve-pixel-verschuiving die de tekst vervaagt).
  const turn = { 0: [1, 0, 0, 1, 0, 0], 90: [0, 1, -1, 0, H, 0], 180: [-1, 0, 0, -1, W, H], 270: [0, -1, 1, 0, 0, W] };
  ctx.transform(...turn[((rotate % 360) + 360) % 360]);
  ctx.drawImage(bitmap, 0, 0, W, H);
  if (grayscale) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
  }
  return canvas;
}

export function canvasToBase64Jpeg(canvas, quality = 0.85) {
  return canvas.toDataURL('image/jpeg', quality).split(',')[1];
}
