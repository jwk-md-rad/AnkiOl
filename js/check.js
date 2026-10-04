// Controle van ingetypte antwoorden, met tolerantie voor hoofdletters,
// accenten, leestekens, lidwoorden en kleine typfouten.

const OPTIONAL_PREFIXES = ['to ', 'the ', 'a ', 'an ', 'de ', 'het ', 'een ', "'t "];

export function normalize(s) {
  let t = String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const p of OPTIONAL_PREFIXES) {
    if (t.startsWith(p)) {
      t = t.slice(p.length);
      break;
    }
  }
  return t.replace(/^'+|'+$/g, '').trim();
}

export function alternatives(expected) {
  const parts = String(expected).split(/[,;/]|\s\|\s/).map(normalize).filter(Boolean);
  const whole = normalize(expected);
  return [...new Set([whole, ...parts])].filter(Boolean);
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function allowedTypos(len) {
  if (len >= 8) return 2;
  if (len >= 4) return 1;
  return 0;
}

// Geeft 'correct', 'almost' (kleine typfout) of 'wrong'.
export function checkAnswer(given, expected) {
  const g = normalize(given);
  if (!g) return 'wrong';
  const alts = alternatives(expected);
  if (alts.includes(g)) return 'correct';
  // Meerdere antwoorden ingetypt (bv. "huis, woning"): elk deel moet kloppen.
  const givenParts = String(given).split(/[,;/]/).map(normalize).filter(Boolean);
  if (givenParts.length > 1 && givenParts.every((p) => alts.includes(p))) return 'correct';
  for (const a of alts) {
    if (levenshtein(g, a) <= allowedTypos(a.length)) return 'almost';
  }
  return 'wrong';
}

// Precies één letter verschil met een goed antwoord (bv. "beautifl" i.p.v.
// "beautiful")? Dan krijgt de leerling eerst een tweede kans.
export function oneLetterOff(given, expected) {
  const g = normalize(given);
  if (!g) return false;
  return alternatives(expected).some((a) => a.length >= 3 && levenshtein(g, a) === 1);
}
