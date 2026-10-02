// Foto inlezen, verkleinen en eventueel grijs maken.

export async function loadImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  return bitmap;
}

export function toCanvas(bitmap, maxSide, { grayscale = false, rotate = 0 } = {}) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const swap = rotate % 180 !== 0;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  if (grayscale) {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(img, 0, 0);
  }
  return canvas;
}

export function canvasToBase64Jpeg(canvas, quality = 0.85) {
  return canvas.toDataURL('image/jpeg', quality).split(',')[1];
}
