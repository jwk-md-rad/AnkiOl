// Gratis tekstherkenning in de browser met Tesseract.js.
// De taalbestanden worden de eerste keer gedownload en daarna bewaard.
import { pairsFromLines, pairsFromText, pairsFromHighlights, highlightInk } from './parse.js';
import { toCanvas } from './image.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let workerPromise;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Kon de OCR-module niet laden. Ben je online?'));
    document.head.appendChild(s);
  });
}

let progressCb = () => {};

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(TESSERACT_URL);
      return window.Tesseract.createWorker(['eng', 'nld'], 1, {
        logger: (m) => progressCb(m),
      });
    })().catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

// Hoeveel goed leesbare tekst staat er op een (kleine) versie van de foto?
async function readability(worker, canvas) {
  const { data } = await worker.recognize(canvas);
  return (data.words || []).filter((w) => w.confidence >= 75).reduce((t, w) => t + w.text.length, 0);
}

// Telefoonfoto's staan vaak op hun kant: probeer de vier standen op een
// kleine versie en kies de stand met de meeste leesbare tekst.
async function bestRotation(worker, canvas, onProgress) {
  onProgress({ status: 'Stand van de foto bepalen' });
  const scores = {};
  const best = () => Number(Object.keys(scores).reduce((a, b) => (scores[b] > scores[a] ? b : a)));
  for (const rot of [0, 90, 270, 180]) {
    scores[rot] = await readability(worker, toCanvas(canvas, 800, { rotate: rot }));
    // Rechtop al duidelijk leesbaar: niet verder zoeken.
    if (rot === 0 && scores[0] >= 120) return 0;
    // Op z'n kant en één stand wint ruim: ondersteboven hoeft niet meer.
    if (rot === 270 && Math.max(scores[90], scores[270]) >= 120 && Math.max(scores[90], scores[270]) > 3 * Math.min(scores[90], scores[270])) return best();
  }
  return best();
}

// Welke woorden zijn gekleurd gedrukt (bv. oranje woorden in voorbeeldzinnen)?
// Daarvoor de kleurenfoto, in dezelfde stand en grootte als wat de OCR las.
function markHighlights(lines, color) {
  const W = color.width;
  const all = color.getContext('2d').getImageData(0, 0, W, color.height).data;
  for (const line of lines) {
    for (const w of line.words || []) {
      const x0 = Math.max(0, w.bbox.x0);
      const x1 = Math.min(W, w.bbox.x1);
      const y0 = Math.max(0, w.bbox.y0);
      const y1 = Math.min(color.height, w.bbox.y1);
      if (x1 <= x0 || y1 <= y0) continue;
      const px = new Uint8ClampedArray((x1 - x0) * (y1 - y0) * 4);
      for (let y = y0; y < y1; y++) px.set(all.subarray((y * W + x0) * 4, (y * W + x1) * 4), (y - y0) * (x1 - x0) * 4);
      w.hl = highlightInk(px);
    }
  }
}

// canvas: grijze foto voor de OCR; color (optioneel): dezelfde foto in kleur.
export async function ocrPairs(canvas, onProgress = () => {}, { psm = '11', autoRotate = true, color = null } = {}) {
  progressCb = onProgress;
  const worker = await getWorker();
  await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: psm });
  const rotation = autoRotate ? await bestRotation(worker, canvas, onProgress) : 0;
  const input = rotation ? toCanvas(canvas, Infinity, { rotate: rotation }) : canvas;
  const { data } = await worker.recognize(input);
  const lines = data.lines || [];
  if (color && lines.length) {
    markHighlights(lines, rotation ? toCanvas(color, Infinity, { rotate: rotation }) : color);
    // Voorbeeldzinnen met gekleurde woorden? Dan die indeling gebruiken.
    const rows = pairsFromHighlights(lines);
    if (rows && rows.filter((r) => r.back).length >= 3) return { rows, text: data.text, rotation };
  }
  const rows = lines.length ? pairsFromLines(lines) : pairsFromText(data.text);
  return { rows, text: data.text, rotation };
}
