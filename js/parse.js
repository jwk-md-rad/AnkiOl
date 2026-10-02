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

// ---------- Kolommen herkennen op een foto van een hele pagina ----------
//
// Een telefoonfoto van een leerboek is scheef en de bladzijde buigt. Daarom:
// 1. regels uit de OCR knippen in stukken (woorden zonder groot gat ertussen),
// 2. stukken groeperen in kolommen,
// 3. per stuk de schuine lijn naar rechts volgen om de vertaling te vinden,
// 4. woordjes die over twee regels doorlopen weer aan elkaar plakken.

const LETTER = /\p{L}/gu;

function letterRatio(s) {
  const letters = (s.match(LETTER) || []).length;
  const visible = s.replace(/\s/g, '').length;
  return { letters, ratio: visible ? letters / visible : 0 };
}

// Lijkt dit op een echt woord, zin of getal (en niet op OCR-rommel)?
export function plausible(text, conf = 100) {
  if (conf < 45) return false;
  if (/^\d{1,5}$/.test(text.trim())) return true;
  const { letters, ratio } = letterRatio(text);
  return letters >= 2 && ratio >= 0.6;
}

// Vakjes (☐ ■) en bolletjes vóór een woord leest OCR als "O", "[J", "B", "WW", "rl" enz.
// Een kort eerste woord wordt weggehaald, tenzij het een echt kort woord is.
const SHORT_WORDS = /^(a|an|to|the|be|go|do|no|so|my|on|in|at|up|of|or|it|is|i|he|we|us|me|by|if|as|en|de|het|een|te|op|er|ik|je|wij|zij|ze)$/i;

function isMark(t) {
  if (SHORT_WORDS.test(t)) return false;
  // Kort woord van alleen kleine letters met een klinker ("one", "two") is echt.
  if (/^\p{Ll}+$/u.test(t) && /[aeiouy]/.test(t)) return false;
  return t.length <= 3;
}

function stripMarks(words) {
  let k = 0;
  while (k < words.length - 1 && isMark(words[k].text)) k++;
  return words.slice(k);
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};

// Kolommen: stukken die (bijna) recht onder elkaar beginnen. Door het
// perspectief kan een kolom schuin lopen; daarom van buur tot buur volgen.
function columnsOf(segs, H, width) {
  const parent = segs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const tol = Math.max(H * 1.5, width * 0.015);
  const order = segs.map((_, i) => i).sort((i, j) => segs[i].y - segs[j].y);
  for (let p = 0; p < order.length; p++) {
    for (let q = p + 1; q < order.length; q++) {
      const a = segs[order[p]];
      const b = segs[order[q]];
      if (b.y - a.y > H * 8) break;
      if (Math.abs(a.x0 - b.x0) < tol) parent[find(order[p])] = find(order[q]);
    }
  }
  const groups = new Map();
  segs.forEach((s, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(s);
  });
  // Stukken van dezelfde kolom met een groot gat ertussen (woorden die de OCR
  // miste) weer samenvoegen: ze liggen onder elkaar en overlappen niet.
  const cols = [...groups.values()].map((g) => ({ segs: g }));
  const info = (c) => {
    const ys = c.segs.map((s) => s.y);
    const top = c.segs[ys.indexOf(Math.min(...ys))];
    const bottom = c.segs[ys.indexOf(Math.max(...ys))];
    return { top, bottom };
  };
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < cols.length && !merged; i++) {
      for (let j = 0; j < cols.length && !merged; j++) {
        if (i === j) continue;
        const up = info(cols[i]);
        const down = info(cols[j]);
        if (up.bottom.y < down.top.y && Math.abs(up.bottom.x0 - down.top.x0) < tol * 1.5) {
          cols[i].segs.push(...cols[j].segs);
          cols.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  return cols.map((c) => ({ segs: c.segs, center: c.segs.reduce((t, s) => t + s.x0, 0) / c.segs.length }));
}

// Uitspraak zoals [ˈbrʌðə] of /ʃuːz/ — ook half herkend ("kaan]", "(to pet").
const PHONETIC = /[[\]/]|[ˈˌːəʌæɪʊɔθðʃʒŋɑɜ]/u;
// Woorden waarmee de tweede regel van een doorlopend woordje begint.
const CONTINUES = /^(and|or|of|en|van)\b/;

// Schuinte van de tekst, gemeten aan de basislijn van de langere woorden.
function wordSlope(words, H) {
  const ms = words
    .map((w) => w.baseline)
    .filter((b) => b && b.has_baseline !== false && b.x1 - b.x0 >= H * 2.5)
    .map((b) => (b.y1 - b.y0) / (b.x1 - b.x0));
  return ms.length ? median(ms) : null;
}

function segmentsFromLines(lines) {
  const words = lines.flatMap((l) => l.words || []);
  const heights = words.map((w) => w.bbox.y1 - w.bbox.y0).filter((x) => x > 0);
  const H = median(heights) || 10;
  // Helling van de regels, voor de hoogte van stukken binnen een lange regel.
  const longSlopes = lines
    .map((l) => l.baseline)
    .filter((b) => b && b.x1 - b.x0 > H * 6)
    .map((b) => (b.y1 - b.y0) / (b.x1 - b.x0));
  const globalSlope = median(longSlopes);

  const segs = [];
  for (const line of lines) {
    const ws = (line.words || [])
      .filter((w) => w.text && w.text.trim() && w.confidence >= 25)
      .sort((a, b) => a.bbox.x0 - b.bbox.x0);
    if (!ws.length) continue;
    const b = line.baseline;
    const lineSlope = b && b.x1 - b.x0 > H * 6 ? (b.y1 - b.y0) / (b.x1 - b.x0) : null;
    const groups = [];
    for (const w of ws) {
      const g = groups[groups.length - 1];
      if (g && w.bbox.x0 - g[g.length - 1].bbox.x1 < H * 1.2) g.push(w);
      else groups.push([w]);
    }
    for (const g0 of groups) {
      // Tussenkopje: een losse hoofdletter gevolgd door een woord met hoofdletter ("B Looks").
      const heading = g0.slice(0, 3).some((w, k) => /^[A-Z]$/.test(w.text) && g0[k + 1] && /^\p{Lu}\p{Ll}/u.test(g0[k + 1].text));
      const g = stripMarks(g0).filter((w) => /[\p{L}\p{N}]/u.test(w.text));
      if (!g.length) continue;
      const x0 = g[0].bbox.x0;
      const x1 = g[g.length - 1].bbox.x1;
      // Hoogte van de basislijn aan het begin van dit stuk.
      const y = b && b.x1 > b.x0 ? b.y0 + ((lineSlope ?? globalSlope) * (x0 - b.x0)) : median(g.map((w) => w.bbox.y1));
      const text = clean(g.map((w) => w.text).join(' '));
      if (!text) continue;
      segs.push({
        text,
        conf: g.reduce((a, w) => a + w.confidence, 0) / g.length,
        x0,
        x1,
        y,
        textSlope: wordSlope(g, H),
        heading,
      });
    }
  }
  return { segs, H };
}

// Welke helling (scheefheid van de foto) laat de meeste stukken netjes naast
// elkaar uitkomen? Probeer een reeks hellingen en tel de koppels.
function findSlope(left, right, H, maxDx, from = -0.25, to = 0.25, step = 0.005) {
  let best = (from + to) / 2;
  let bestScore = -1;
  for (let m = from; m <= to + 1e-9; m += step) {
    let score = 0;
    for (const a of left) {
      for (const b of right) {
        const dx = b.x0 - a.x0;
        if (dx < H * 2 || dx > maxDx) continue;
        if (Math.abs(b.y - a.y - m * dx) < H * 0.25) score++;
      }
    }
    if (score > bestScore || (score === bestScore && Math.abs(m - (from + to) / 2) < Math.abs(best - (from + to) / 2))) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

// Koppel stukken uit kolom A aan stukken uit kolom B (rechts ervan), van boven
// naar beneden zonder dat lijnen elkaar kruisen. De verwachte hoogte past zich
// aan aan buigende bladzijdes (lineaire correctie op de afwijking).
function matchColumns(A, B, H, globalSlope) {
  // De bladzijde buigt: per kolompaar de eigen helling. Startpunt is de
  // schuinte van de woorden zelf; daarna fijn zoeken in een klein bereik
  // (een groot bereik vindt ook hellingen die precies één regel verschoven zijn).
  const own = [...A.segs, ...B.segs].map((s) => s.textSlope).filter((m) => m !== null);
  const m0 = own.length >= 3 ? median(own) : globalSlope;
  const slope = findSlope(A.segs, B.segs, H, Infinity, m0 - 0.04, m0 + 0.04, 0.0025);
  // Helling ter plekke: schuinte van de woorden in de buurt (boven/onder).
  const withSlope = [...A.segs, ...B.segs].filter((s) => s.textSlope !== null);
  const localSlope = (a) => {
    const near = [...withSlope].sort((p, q) => Math.abs(p.y - a.y) - Math.abs(q.y - a.y)).slice(0, 6);
    return near.length >= 3 ? slope + (median(near.map((s) => s.textSlope)) - m0) : slope;
  };
  const as = [...A.segs].sort((p, q) => p.y - q.y);
  const slopeOf = new Map(as.map((a) => [a, localSlope(a)]));
  const bs = [...B.segs].sort((p, q) => p.y - q.y);
  let fix = { c0: 0, c1: 0 };
  let pairs = [];
  for (const limit of [0.9, 0.6]) {
    const resid = (a, b) => b.y - (a.y + (slopeOf.get(a) ?? slope) * (b.x0 - a.x0) + fix.c0 + fix.c1 * a.y);
    // Uitlijning (zoals bij het vergelijken van twee rijtjes): maximaliseer goede koppels.
    const n = as.length;
    const m = bs.length;
    const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    const move = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        let v = score[i - 1][j];
        let mv = 1;
        if (score[i][j - 1] > v) {
          v = score[i][j - 1];
          mv = 2;
        }
        const r = Math.abs(resid(as[i - 1], bs[j - 1])) / H;
        if (r < limit && score[i - 1][j - 1] + (1 - r) > v) {
          v = score[i - 1][j - 1] + (1 - r);
          mv = 3;
        }
        score[i][j] = v;
        move[i][j] = mv;
      }
    }
    pairs = [];
    for (let i = n, j = m; i > 0 && j > 0; ) {
      if (move[i][j] === 3) {
        pairs.push([as[i - 1], bs[j - 1]]);
        i--;
        j--;
      } else if (move[i][j] === 1) i--;
      else j--;
    }
    pairs.reverse();
    // Afwijking per hoogte schatten (rechte lijn) voor de tweede, strengere ronde.
    if (pairs.length >= 3) {
      const pts = pairs.map(([a, b]) => [a.y, resid(a, b) + fix.c0 + fix.c1 * a.y]);
      const mx = pts.reduce((t, p) => t + p[0], 0) / pts.length;
      const my = pts.reduce((t, p) => t + p[1], 0) / pts.length;
      const sxx = pts.reduce((t, p) => t + (p[0] - mx) ** 2, 0);
      const sxy = pts.reduce((t, p) => t + (p[0] - mx) * (p[1] - my), 0);
      const c1 = sxx ? sxy / sxx : 0;
      fix = { c0: my - c1 * mx, c1 };
    }
  }
  return pairs;
}

// Kies welke kolommen samen woord ↔ vertaling vormen.
function pickColumnPairs(cols, H, slope) {
  const max = Math.max(...cols.map((c) => c.segs.length));
  const main = cols
    .filter((c) => c.segs.length >= Math.max(2, max * 0.3))
    // Uitspraak-kolom ([ˈbrʌðə]) en kolommen vol OCR-rommel overslaan.
    .filter((c) => c.segs.filter((s) => PHONETIC.test(s.text) || s.conf < 60 || !plausible(s.text, s.conf)).length < c.segs.length * 0.5)
    .sort((a, b) => a.center - b.center);
  const result = [];
  let best = 0;
  // Steeds de twee naast elkaar liggende kolommen met de meeste koppels.
  while (main.length >= 2) {
    let pick = 0;
    let pickMatches = matchColumns(main[0], main[1], H, slope);
    for (let k = 1; k < main.length - 1; k++) {
      const m = matchColumns(main[k], main[k + 1], H, slope);
      if (m.length > pickMatches.length) {
        pick = k;
        pickMatches = m;
      }
    }
    if (pickMatches.length < 2 || pickMatches.length < best * 0.3) break;
    best = Math.max(best, pickMatches.length);
    const [A, B] = main.splice(pick, 2);
    result.push({ A, B, matches: pickMatches });
  }
  result.sort((a, b) => a.A.center - b.A.center);
  // Overgebleven kolom (bv. getallen die iets verder rechts staan dan de
  // vertalingen eronder): koppel aan de woordkolom links ervan.
  for (const L of main) {
    const owner = [...result].reverse().find((r) => r.A.center < L.center);
    if (!owner) continue;
    const used = new Set(owner.matches.map(([a]) => a));
    const rest = { segs: owner.A.segs.filter((a) => !used.has(a)) };
    const extra = matchColumns(rest, L, H, slope);
    if (extra.length >= 2) {
      owner.matches.push(...extra);
      owner.extraCols = [...(owner.extraCols || []), L];
    }
  }
  return result;
}

function joinText(first, second) {
  return /-$/.test(first) ? first + second : `${first} ${second}`;
}

const unclosed = (t) => (t.match(/\(/g) || []).length > (t.match(/\)/g) || []).length;

// Doorlopende woordjes: een los stuk vlak onder/boven een gekoppeld stuk aanplakken.
function attachContinuations(col, side, rowsBySeg, used, spacing, rotY) {
  const sorted = [...col.segs].sort((a, b) => rotY(a) - rotY(b));
  sorted.forEach((s, k) => {
    if (used.has(s)) return;
    const prev = sorted[k - 1];
    const next = sorted[k + 1];
    const near = (o) => o && Math.abs(rotY(o) - rotY(s)) < spacing * 1.6;
    if (near(prev) && rowsBySeg.has(prev)) {
      const row = rowsBySeg.get(prev);
      if (/[-,]$/.test(row[side]) || unclosed(row[side])) {
        row[side] = joinText(row[side], s.text);
        used.add(s);
        rowsBySeg.set(s, row);
        return;
      }
    }
    if (near(next) && rowsBySeg.has(next) && CONTINUES.test(next.text)) {
      const row = rowsBySeg.get(next);
      row[side] = joinText(s.text, row[side]);
      used.add(s);
      rowsBySeg.set(s, row);
    }
  });
}

// Tesseract-regels (met woorden, posities en basislijn) → woordparen.
export function pairsFromLines(lines) {
  const { segs, H } = segmentsFromLines(lines || []);
  if (!segs.length) return [];
  const width0 = Math.max(...segs.map((s) => s.x1)) - Math.min(...segs.map((s) => s.x0));
  const tan = findSlope(segs, segs, H, width0 * 0.45);
  // Rechtgezette coördinaten (alleen voor kolommen en volgorde).
  const rotY = (s) => s.y - s.x0 * tan;
  const cols = columnsOf(segs, H, width0);

  const out = [];
  for (const { A, B, matches, extraCols = [] } of pickColumnPairs(cols, H, tan)) {
    const rows = matches.map(([a, b]) => ({ a, front: a.text, back: b.text, okA: plausible(a.text, a.conf), okB: plausible(b.text, b.conf) }));
    const ys = matches.map(([a]) => rotY(a)).sort((x, y) => x - y);
    const spacing = median(ys.slice(1).map((y, k) => y - ys[k]).filter((d) => d > H * 0.5)) || H * 2;
    const used = new Set(matches.flat());
    const rowA = new Map(rows.map((r, k) => [matches[k][0], r]));
    const rowB = new Map(rows.map((r, k) => [matches[k][1], r]));
    attachContinuations(A, 'front', rowA, used, spacing, rotY);
    attachContinuations(B, 'back', rowB, used, spacing, rotY);
    for (const L of extraCols) attachContinuations(L, 'back', rowB, used, spacing, rotY);
    const lower = rows.filter((r) => /^\p{Ll}/u.test(r.front)).length > rows.length / 2;
    const capitalized = (r) => lower && /^\p{Lu}/u.test(r.front) && /^\p{Lu}/u.test(r.back);
    const found = rows.map((r) => ({ y: rotY(r.a), front: r.front, back: r.back, ok: r.okA && r.okB && !r.a.heading && !capitalized(r) }));
    // Losse woorden zonder vertaling: wel tonen, niet aanvinken.
    for (const s of A.segs) {
      if (!used.has(s) && plausible(s.text, s.conf)) found.push({ y: rotY(s), front: s.text, back: '', ok: false });
    }
    found.sort((x, y) => x.y - y.y);
    // Losse regel met veel ruimte eromheen (meestal een kopje): niet aanvinken.
    const paired = found.filter((f) => f.back);
    if (paired.length >= 3) {
      paired.forEach((f, k) => {
        const before = k ? f.y - paired[k - 1].y : Infinity;
        const after = k < paired.length - 1 ? paired[k + 1].y - f.y : Infinity;
        if (before > spacing * 2.5 && after > spacing * 2.5) f.ok = false;
      });
    }
    out.push(...found.map(({ front, back, ok }) => ({ front, back, ok })));
  }
  return out;
}
