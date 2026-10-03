// Samenvoegen van twee versies van alle gegevens (bv. Chromebook en iPhone).
//
// - Per hoofdstuk/kaartje wint de laatst gewijzigde versie (veld `updated`).
// - Voor de voortgang per richting wint de laatste keer overhoren, zodat
//   oefenen op beide apparaten niet verloren gaat.
// - Stone-oefeningen houden de varianten van beide kanten.
// - Verwijderd (in `deleted`, id → tijdstip) blijft verwijderd, tenzij het daarna
//   opnieuw is gewijzigd.

const KEEP_TOMBSTONES = 180 * 24 * 3600 * 1000;
const MAX_VARIANTS = 40;

const sameText = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function newer(x, y) {
  if (!x) return y;
  if (!y) return x;
  return (y.updated || 0) > (x.updated || 0) ? y : x;
}

function laterReview(s, t) {
  if (!s) return t;
  if (!t) return s;
  return (t.lastReview || 0) > (s.lastReview || 0) ? t : s;
}

function mergeCard(x, y) {
  if (!x || !y) return { ...(x || y) };
  const base = newer(x, y);
  const other = base === x ? y : x;
  const card = { ...base, fwd: laterReview(x.fwd, y.fwd), rev: laterReview(x.rev, y.rev) };
  if (base.kind === 'stone') {
    const seen = new Set((base.variants || []).map((v) => sameText(v.prompt)));
    const variants = [...(base.variants || [])];
    for (const v of other.variants || []) {
      if (!seen.has(sameText(v.prompt))) {
        seen.add(sameText(v.prompt));
        variants.push(v);
      }
    }
    const extra = variants.length - MAX_VARIANTS;
    if (extra > 0) {
      variants.splice(0, extra);
      if (card.lastVariant !== undefined) card.lastVariant = Math.max(-1, card.lastVariant - extra);
    }
    card.variants = variants;
  }
  return card;
}

function byId(list) {
  return new Map((list || []).map((r) => [r.id, r]));
}

export function mergeData(a, b, now = Date.now()) {
  const deleted = {};
  for (const src of [a.deleted || {}, b.deleted || {}]) {
    for (const [id, t] of Object.entries(src)) {
      if (now - t < KEEP_TOMBSTONES) deleted[id] = Math.max(deleted[id] || 0, t);
    }
  }
  const gone = (r) => deleted[r.id] !== undefined && deleted[r.id] >= (r.updated || 0);

  const da = byId(a.decks);
  const db = byId(b.decks);
  const decks = [];
  for (const id of new Set([...da.keys(), ...db.keys()])) {
    const d = { ...newer(da.get(id), db.get(id)) };
    if (!gone(d)) decks.push(d);
  }
  const deckIds = new Set(decks.map((d) => d.id));

  const ca = byId(a.cards);
  const cb = byId(b.cards);
  const cards = [];
  for (const id of new Set([...ca.keys(), ...cb.keys()])) {
    const c = mergeCard(ca.get(id), cb.get(id));
    if (!gone(c) && deckIds.has(c.deckId)) cards.push(c);
  }
  return { decks, cards, deleted };
}
