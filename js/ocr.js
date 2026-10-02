// Gratis tekstherkenning in de browser met Tesseract.js.
// De taalbestanden worden de eerste keer gedownload en daarna bewaard.
import { pairsFromOcrLines, pairsFromText } from './parse.js';

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

export async function ocrPairs(canvas, onProgress = () => {}) {
  progressCb = onProgress;
  const worker = await getWorker();
  await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '6' });
  const { data } = await worker.recognize(canvas);
  const lines = data.lines && data.lines.length ? data.lines : null;
  const rows = lines ? pairsFromOcrLines(lines) : pairsFromText(data.text);
  return { rows, text: data.text };
}
