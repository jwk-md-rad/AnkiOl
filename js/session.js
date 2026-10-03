// Een overhoorsessie: bepaalt welke kaart als volgende komt.
import { schedule, MINUTE } from './srs.js';

export const LEARN_AHEAD = 20 * MINUTE;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Stone-oefeningen hebben maar één richting (de opdracht zelf bepaalt de taal).
export function dirsFor(card, dirs) {
  return card.kind === 'stone' ? ['fwd'] : dirs;
}

// Welke variant van een Stone-oefening deze keer? Steeds een andere.
export function nextVariant(card) {
  const n = (card.variants || []).length;
  if (n <= 1) return 0;
  return ((card.lastVariant ?? -1) + 1) % n;
}

// Is dit de laatste nog niet herhaalde variant? Dan zijn er nieuwe nodig.
export function needsMoreVariants(card, shown) {
  return card.kind === 'stone' && shown >= (card.variants || []).length - 1;
}

const sameText = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Nieuwe varianten toevoegen: geen dubbele, en maximaal `max` bewaren
// (de oudste vallen weg). Geeft het aantal toegevoegde varianten terug.
export function addVariants(card, fresh, max = 40) {
  const known = new Set(card.variants.map((v) => sameText(v.prompt)));
  let added = 0;
  for (const v of fresh) {
    const key = sameText(v.prompt);
    if (!key || known.has(key)) continue;
    known.add(key);
    card.variants.push(v);
    added++;
  }
  const extra = card.variants.length - max;
  if (extra > 0) {
    card.variants.splice(0, extra);
    if (card.lastVariant !== undefined) card.lastVariant = Math.max(-1, card.lastVariant - extra);
  }
  return added;
}

export function countDue(cards, dirs, now = Date.now()) {
  let fresh = 0;
  let learn = 0;
  let review = 0;
  for (const c of cards) {
    for (const d of dirsFor(c, dirs)) {
      const s = c[d];
      if (s.state === 'new') fresh++;
      else if (s.due <= now) {
        if (s.state === 'review') review++;
        else learn++;
      }
    }
  }
  return { fresh, learn, review };
}

export class Session {
  constructor(cards, dirs, { newLimit = 20, now = Date.now(), oneDirPerCard = true } = {}) {
    this.items = [];
    const fresh = [];
    for (const card of cards) {
      for (const dir of dirsFor(card, dirs)) {
        const s = card[dir];
        if (s.state === 'new') fresh.push({ card, dir });
        else if (s.due <= now + LEARN_AHEAD) this.items.push({ card, dir });
      }
    }
    // Nieuwe kaarten: dezelfde kaart niet in beide richtingen op dezelfde dag introduceren.
    const seen = new Set();
    const picked = [];
    for (const it of fresh.sort((a, b) => a.card.created - b.card.created)) {
      if (picked.length >= newLimit) break;
      if (oneDirPerCard && seen.has(it.card.id)) continue;
      seen.add(it.card.id);
      picked.push(it);
    }
    this.newItems = shuffle(picked);
    this.items = shuffle(this.items);
    this.stats = { answered: 0, again: 0 };
    this.lastId = null;
  }

  counts(now = Date.now()) {
    let learn = 0;
    let review = 0;
    for (const { card, dir } of this.items) {
      if (card[dir].state === 'review') review++;
      else learn++;
    }
    return { fresh: this.newItems.length, learn, review, now };
  }

  // Volgende kaart, of null als de sessie klaar is.
  next(now = Date.now()) {
    const due = this.items.filter(({ card, dir }) => card[dir].due <= now);
    const pick = (list) => {
      const notLast = list.filter((it) => it.card.id !== this.lastId);
      return (notLast.length ? notLast : list).sort((a, b) => a.card[a.dir].due - b.card[b.dir].due)[0];
    };
    // Herhalingen en nieuwe kaarten afwisselen: om de 3 kaarten een nieuwe.
    const wantNew = this.newItems.length && (!due.length || this.stats.answered % 3 === 2);
    if (wantNew) {
      const idx = this.newItems.findIndex((it) => it.card.id !== this.lastId);
      if (idx >= 0) return this.newItems[idx];
    }
    if (due.length) return pick(due);
    if (this.newItems.length) return this.newItems[0];
    // Niets meer nu: leerkaarten die binnenkort weer aan de beurt zijn, alvast tonen.
    const soon = this.items.filter(({ card, dir }) => card[dir].due <= now + LEARN_AHEAD);
    return soon.length ? pick(soon) : null;
  }

  answer(item, rating, now = Date.now()) {
    const wasNew = item.card[item.dir].state === 'new';
    item.card[item.dir] = schedule(item.card[item.dir], rating, now);
    this.newItems = this.newItems.filter((it) => it !== item);
    this.items = this.items.filter((it) => it !== item);
    if (item.card[item.dir].due <= now + LEARN_AHEAD * 3 && item.card[item.dir].state !== 'review') {
      this.items.push(item);
    }
    this.stats.answered++;
    if (rating === 1) this.stats.again++;
    this.lastId = item.card.id;
    return { wasNew };
  }
}
