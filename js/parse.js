// Zet herkende tekst (OCR of geplakt) om in woordparen.

const SEPARATOR = /\s+[-–—=:→>|]+\s+|\t+|\s{3,}/;
const NUMBERING = /^\s*(\d{1,3}[.)]|[•·*▪●-])\s*/;

function clean(s) {
  return s.replace(NUMBERING, '').replace(/\s+/g, ' ').replace(/^[\s|:;,.]+|[\s|:;]+$/g, '').trim();
}

// Een regel als "house - huis" of "house    huis" → { front, back }.
export function splitLine(line) {
  const parts = line.split(SEPARATOR).map(clean).filter(Boolean);
  if (parts.length < 2) return null;
  return { front: parts[0], back: parts[parts.length - 1] };
}

export function pairsFromText(text) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const pair = splitLine(line);
    if (pair) rows.push({ ...pair, ok: true });
    else if (clean(line).length > 1) rows.push({ front: clean(line), back: '', ok: false });
  }
  return rows;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// OCR-regels met woordposities (bbox) → paren. Kolommen in een leerboek
// worden herkend aan het grootste horizontale gat tussen woorden.
export function pairsFromOcrLines(lines) {
  const rows = [];
  for (const line of lines) {
    const words = (line.words || []).filter((w) => w.text && w.text.trim());
    const text = line.text ? line.text.trim() : words.map((w) => w.text).join(' ');
    if (!words.length) {
      if (text) rows.push(...pairsFromText(text));
      continue;
    }
    // Eerst expliciete scheidingstekens proberen.
    const explicit = splitLine(text);
    if (explicit) {
      rows.push({ ...explicit, ok: true });
      continue;
    }
    const heights = words.map((w) => w.bbox.y1 - w.bbox.y0);
    const h = median(heights) || 10;
    const gaps = [];
    for (let i = 1; i < words.length; i++) gaps.push(words[i].bbox.x0 - words[i - 1].bbox.x1);
    const big = gaps.map((g, i) => ({ g, i })).filter(({ g }) => g > h * 1.6);
    if (!big.length) {
      const t = clean(text);
      if (t.length > 1) rows.push({ front: t, back: '', ok: false });
      continue;
    }
    // Kolommen: front = eerste kolom, back = laatste kolom.
    const first = big[0].i + 1;
    const last = big[big.length - 1].i + 1;
    const front = clean(words.slice(0, first).map((w) => w.text).join(' '));
    const back = clean(words.slice(last).map((w) => w.text).join(' '));
    if (front && back) rows.push({ front, back, ok: true });
  }
  return rows;
}
