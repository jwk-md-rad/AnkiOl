// Geplakte of getypte tekst → woordparen, en woorden terugvinden in een voorbeeldzin.

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

// Waar staat het woord (of de woordgroep) in de voorbeeldzin? Geeft [begin, eind]-stukken.
// Werkt ook met vervoegingen ("focus" in "focusing") en losse delen ("be lucky" in "be very lucky").
export function findInSentence(sentence, phrase) {
  const want = String(phrase).toLowerCase().match(/[\p{L}\p{N}'’]+/gu) || [];
  if (!want.length) return [];
  const tokens = [...String(sentence).matchAll(/[\p{L}\p{N}'’-]+/gu)];
  const out = [];
  let t = 0;
  for (const w of want) {
    while (t < tokens.length && !tokens[t][0].toLowerCase().startsWith(w)) t++;
    if (t === tokens.length) return [];
    out.push([tokens[t].index, tokens[t].index + tokens[t][0].length]);
    t++;
  }
  return out;
}
