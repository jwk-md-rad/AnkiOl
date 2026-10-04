// Controle van ingetypte antwoorden, met tolerantie voor hoofdletters,
// accenten, leestekens, lidwoorden en kleine typfouten.

const OPTIONAL_PREFIXES = ['to ', 'the ', 'a ', 'an ', 'de ', 'het ', 'een ', "'t "];

// Engelse samentrekkingen uitschrijven, zodat "it's" en "it is", "don't" en
// "do not", "can't" en "cannot" enz. als hetzelfde antwoord tellen.
// 's wordt alleen uitgeschreven na voornaamwoorden en vraagwoorden (niet bij
// "Tom's" = van Tom), en is "has" vóór got/been ("he's got" = "he has got").
const S_WORDS = 'he|she|it|that|there|here|what|where|who|how|when|why';
const CONTRACTIONS = [
  [/\bcannot\b/g, 'can not'],
  [/\bcan't\b/g, 'can not'],
  [/\bwon't\b/g, 'will not'],
  [/\bshan't\b/g, 'shall not'],
  [/\b(\w+)n't\b/g, '$1 not'],
  [/\bi'm\b/g, 'i am'],
  [/\blet's\b/g, 'let us'],
  [/\b(\w+)'re\b/g, '$1 are'],
  [/\b(\w+)'ve\b/g, '$1 have'],
  [/\b(\w+)'ll\b/g, '$1 will'],
  [/\b(\w+)'d (been|better|got)\b/g, '$1 had $2'],
  [/\b(\w+)'d\b/g, '$1 would'],
  [new RegExp(`\\b(${S_WORDS})'s (got|been)\\b`, 'g'), '$1 has $2'],
  [new RegExp(`\\b(${S_WORDS})'s\\b`, 'g'), '$1 is'],
];

function expandContractions(t) {
  for (const [re, to] of CONTRACTIONS) t = t.replace(re, to);
  return t;
}

// Zelfde antwoord, alleen de apostrof vergeten ("dont" ↔ "don't", "Im" ↔ "I'm")?
function withoutApostrophes(s) {
  return String(s)
    .toLowerCase()
    .replace(/[’‘`']/g, '')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function missingApostrophe(given, expected) {
  const g = withoutApostrophes(given);
  return String(expected)
    .split(/[,;/]|\s\|\s/)
    .some((a) => /['’]/.test(a) && withoutApostrophes(a) === g);
}

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
  t = expandContractions(t);
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

// Aantal typfouten tussen twee woorden: een letter vergeten, te veel, verkeerd,
// of twee letters omgewisseld ("hius" ↔ "huis") telt elk als één fout.
export function typoDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
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
  if (missingApostrophe(given, expected)) return 'almost';
  for (const a of alts) {
    if (typoDistance(g, a) <= allowedTypos(a.length)) return 'almost';
  }
  return 'wrong';
}

// Precies één typfout verschil met een goed antwoord (bv. "beautifl" i.p.v.
// "beautiful", of "hius" i.p.v. "huis")? Dan krijgt de leerling eerst een tweede kans.
export function oneLetterOff(given, expected) {
  const g = normalize(given);
  if (!g) return false;
  if (alternatives(expected).includes(g)) return false;
  if (missingApostrophe(given, expected)) return true;
  return alternatives(expected).some((a) => a.length >= 3 && typoDistance(g, a) === 1);
}
