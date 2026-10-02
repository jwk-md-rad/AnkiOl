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

// ---------- Kolommen herkennen op een hele pagina ----------

const LETTER = /\p{L}/gu;

function letterRatio(s) {
  const letters = (s.match(LETTER) || []).length;
  const visible = s.replace(/\s/g, '').length;
  return { letters, ratio: visible ? letters / visible : 0 };
}

// Lijkt dit op een echt woord of echte zin (en niet op OCR-rommel)?
export function plausible(text, conf = 100) {
  const { letters, ratio } = letterRatio(text);
  return letters >= 2 && ratio >= 0.6 && conf >= 45;
}

// Schuine foto: hoek uit de basislijnen van de herkende regels.
export function skewAngle(lines) {
  const slopes = [];
  for (const l of lines || []) {
    const b = l.baseline;
    if (!b || b.x1 - b.x0 < 150) continue;
    slopes.push((b.y1 - b.y0) / (b.x1 - b.x0));
  }
  if (!slopes.length) return 0;
  slopes.sort((a, b) => a - b);
  return Math.atan(slopes[Math.floor(slopes.length / 2)]);
}

function clusterBy(items, key, tol) {
  const sorted = [...items].sort((a, b) => key(a) - key(b));
  const groups = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && key(it) - g.last <= tol) {
      g.items.push(it);
      g.last = key(it);
      g.sum += key(it);
    } else groups.push({ items: [it], last: key(it), sum: key(it) });
  }
  return groups.map((g) => ({ items: g.items, center: g.sum / g.items.length }));
}

// Uitspraak zoals [ˈbrʌðə] of /ʃuːz/ — ook half herkend ("kaan]", "(to pet").
const PHONETIC = /[[\]/]|[ˈˌːəʌæɪʊɔθðʃʒŋɑɜ]/u;

// Kies welke kolommen samen woord ↔ vertaling vormen.
function pickColumnPairs(cols) {
  const max = Math.max(...cols.map((c) => c.rows.size));
  const main = cols
    .filter((c) => c.rows.size >= Math.max(2, max * 0.6))
    // Uitspraak-kolom ([ˈbrʌðə]) overslaan.
    .filter((c) => c.segs.filter((s) => PHONETIC.test(s.text)).length < c.segs.length * 0.4)
    // Kolommen die vooral uit OCR-rommel bestaan (vaak onleesbare uitspraak) ook.
    .filter((c) => c.segs.filter((s) => plausible(s.text, s.conf)).length >= c.segs.length * 0.6)
    .sort((a, b) => a.center - b.center);
  const together = (a, b) => [...a.rows].filter((r) => b.rows.has(r)).length;
  const pairs = [];
  let best = 0;
  // Steeds de twee naast elkaar liggende kolommen die de meeste regels delen.
  while (main.length >= 2) {
    let pick = 0;
    for (let k = 1; k < main.length - 1; k++) {
      if (together(main[k], main[k + 1]) > together(main[pick], main[pick + 1])) pick = k;
    }
    const n = together(main[pick], main[pick + 1]);
    if (n < 2 || n < best * 0.5) break;
    best = Math.max(best, n);
    pairs.push(main.splice(pick, 2));
  }
  return pairs.sort((a, b) => a[0].center - b[0].center);
}

// OCR-woorden (met positie en betrouwbaarheid) → woordparen.
export function pairsFromWords(words, angle = 0) {
  const tan = Math.tan(angle);
  const ws = words
    .filter((w) => w.text && /[\p{L}\p{N}]/u.test(w.text) && w.confidence >= 30)
    .map((w) => {
      const cx = (w.bbox.x0 + w.bbox.x1) / 2;
      const cy = (w.bbox.y0 + w.bbox.y1) / 2;
      return {
        text: w.text.trim(),
        conf: w.confidence,
        h: w.bbox.y1 - w.bbox.y0,
        // Coördinaten rechtgezet voor een scheve foto.
        x0: w.bbox.x0 + w.bbox.y0 * tan,
        x1: w.bbox.x1 + w.bbox.y0 * tan,
        cy: cy - cx * tan,
      };
    });
  if (!ws.length) return [];
  const hs = ws.map((w) => w.h).sort((a, b) => a - b);
  const h = hs[Math.floor(hs.length / 2)] || 10;

  // Regels: woorden op dezelfde hoogte.
  const rows = clusterBy(ws, (w) => w.cy, h * 0.45).map((g, ri) => {
    const sorted = g.items.sort((a, b) => a.x0 - b.x0);
    // Stukken: woorden zonder groot gat ertussen.
    const segs = [];
    for (const w of sorted) {
      const s = segs[segs.length - 1];
      if (s && w.x0 - s.x1 < h * 1.3) {
        s.words.push(w);
        s.x1 = Math.max(s.x1, w.x1);
      } else segs.push({ words: [w], x0: w.x0, x1: w.x1, row: ri });
    }
    for (const s of segs) {
      s.text = clean(s.words.map((w) => w.text).join(' '));
      s.conf = s.words.reduce((a, w) => a + w.conf, 0) / s.words.length;
    }
    return { cy: g.center, segs };
  });

  // Kolommen: stukken die op (ongeveer) dezelfde x beginnen.
  const allSegs = rows.flatMap((r) => r.segs);
  const width = Math.max(...allSegs.map((s) => s.x1)) - Math.min(...allSegs.map((s) => s.x0));
  const cols = clusterBy(allSegs, (s) => s.x0, Math.max(h * 2, width * 0.03)).map((c) => ({
    center: c.center,
    segs: c.items,
    rows: new Set(c.items.map((s) => s.row)),
  }));
  const colOf = new Map();
  cols.forEach((c) => c.segs.forEach((s) => colOf.set(s, c)));

  const out = [];
  const pairs = pickColumnPairs(cols);
  if (!pairs.length) {
    // Geen duidelijke kolommen: per regel eerste en laatste stuk.
    for (const r of rows) {
      if (r.segs.length >= 2) {
        const a = r.segs[0];
        const b = r.segs[r.segs.length - 1];
        out.push({ front: a.text, back: b.text, ok: plausible(a.text, a.conf) && plausible(b.text, b.conf) });
      }
    }
    return out;
  }
  for (const [A, B] of pairs) {
    const found = [];
    for (const r of rows) {
      const a = r.segs.find((s) => colOf.get(s) === A);
      const b = r.segs.find((s) => colOf.get(s) === B);
      if (!a && !b) continue;
      if (a && b) found.push({ cy: r.cy, front: a.text, back: b.text, ok: plausible(a.text, a.conf) && plausible(b.text, b.conf) });
      else if (a && plausible(a.text, a.conf)) found.push({ cy: r.cy, front: a.text, back: '', ok: false });
    }
    // Losse regel met veel ruimte eromheen (meestal een kopje): niet aanvinken.
    const paired = found.filter((f) => f.back);
    const gaps = paired.slice(1).map((f, k) => f.cy - paired[k].cy).sort((x, y) => x - y);
    const spacing = gaps[Math.floor((gaps.length - 1) / 2)];
    if (paired.length >= 3) {
      paired.forEach((f, k) => {
        const before = k ? f.cy - paired[k - 1].cy : Infinity;
        const after = k < paired.length - 1 ? paired[k + 1].cy - f.cy : Infinity;
        if (before > spacing * 2 && after > spacing * 2) f.ok = false;
      });
    }
    out.push(...found.map(({ front, back, ok }) => ({ front, back, ok })));
  }
  return out;
}
