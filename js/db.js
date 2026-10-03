// Lokale opslag in IndexedDB (blijft op de Chromebook, werkt offline).
import { newState } from './srs.js';
import { mergeData } from './merge.js';

const DB_NAME = 'woordjes';
const VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('decks', { keyPath: 'id' });
        const cards = db.createObjectStore('cards', { keyPath: 'id' });
        cards.createIndex('deckId', 'deckId');
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(stores, mode, fn) {
  const db = await open();
  const t = db.transaction(stores, mode);
  const result = await fn(t);
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return result;
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function listDecks() {
  const decks = await tx(['decks'], 'readonly', (t) => wrap(t.objectStore('decks').getAll()));
  return decks.sort((a, b) => a.name.localeCompare(b.name, 'nl'));
}

export const getDeck = (id) => tx(['decks'], 'readonly', (t) => wrap(t.objectStore('decks').get(id)));

// Wordt aangeroepen na elke wijziging (voor automatisch synchroniseren).
let onChange = () => {};
export function setOnChange(fn) {
  onChange = fn;
}

// Verwijderde hoofdstukken/kaartjes onthouden (id → tijdstip), zodat ze bij
// het synchroniseren niet terugkomen vanaf het andere apparaat.
async function addTombstones(t, ids) {
  const store = t.objectStore('meta');
  const row = await wrap(store.get('deleted'));
  const deleted = row ? row.value : {};
  const now = Date.now();
  for (const id of ids) deleted[id] = now;
  store.put({ key: 'deleted', value: deleted });
}

export async function saveDeck(deck) {
  const d = { frontLang: 'en', backLang: 'nl', created: Date.now(), ...deck, id: deck.id || uid(), updated: Date.now() };
  await tx(['decks'], 'readwrite', (t) => wrap(t.objectStore('decks').put(d)));
  onChange();
  return d;
}

export async function deleteDeck(id) {
  await tx(['decks', 'cards', 'meta'], 'readwrite', async (t) => {
    const keys = await wrap(t.objectStore('cards').index('deckId').getAllKeys(id));
    for (const k of keys) t.objectStore('cards').delete(k);
    t.objectStore('decks').delete(id);
    await addTombstones(t, [id, ...keys]);
  });
  onChange();
}

export const listCards = (deckId) =>
  tx(['cards'], 'readonly', (t) => wrap(t.objectStore('cards').index('deckId').getAll(deckId)));

export const allCards = () => tx(['cards'], 'readonly', (t) => wrap(t.objectStore('cards').getAll()));

export function makeCard(deckId, front, back) {
  return { id: uid(), deckId, front, back, created: Date.now(), fwd: newState(), rev: newState() };
}

// Stone-oefening: één kaartje met meerdere varianten (prompt → antwoord).
export function makeStoneCard(deckId, stone, exercise) {
  const first = exercise.variants[0];
  return {
    id: uid(),
    deckId,
    kind: 'stone',
    stone,
    type: exercise.type,
    pattern: exercise.pattern,
    variants: exercise.variants,
    front: first.prompt,
    back: first.answer,
    created: Date.now(),
    fwd: newState(),
    rev: newState(),
  };
}

export async function putCards(cards) {
  const now = Date.now();
  await tx(['cards'], 'readwrite', (t) => {
    for (const c of cards) {
      c.updated = now;
      t.objectStore('cards').put(c);
    }
  });
  onChange();
}

export async function deleteCard(id) {
  await tx(['cards', 'meta'], 'readwrite', async (t) => {
    t.objectStore('cards').delete(id);
    await addTombstones(t, [id]);
  });
  onChange();
}

export async function getMeta(key, fallback) {
  const row = await tx(['meta'], 'readonly', (t) => wrap(t.objectStore('meta').get(key)));
  return row ? row.value : fallback;
}

export const setMeta = (key, value) =>
  tx(['meta'], 'readwrite', (t) => wrap(t.objectStore('meta').put({ key, value })));

export async function exportAll() {
  return {
    app: 'woordjes',
    version: 1,
    exported: new Date().toISOString(),
    decks: await listDecks(),
    cards: await allCards(),
    deleted: await getMeta('deleted', {}),
  };
}

// Resultaat van synchroniseren wegschrijven. Binnen dezelfde opslagactie nog
// eens samenvoegen met wat er nu lokaal staat, zodat een kaartje dat tijdens
// het synchroniseren werd overhoord niet wordt overschreven.
export async function applySynced(synced) {
  let result;
  await tx(['decks', 'cards', 'meta'], 'readwrite', async (t) => {
    const current = {
      decks: await wrap(t.objectStore('decks').getAll()),
      cards: await wrap(t.objectStore('cards').getAll()),
      deleted: ((await wrap(t.objectStore('meta').get('deleted'))) || {}).value || {},
    };
    result = mergeData(current, synced);
    t.objectStore('decks').clear();
    t.objectStore('cards').clear();
    for (const d of result.decks) t.objectStore('decks').put(d);
    for (const c of result.cards) t.objectStore('cards').put(c);
    t.objectStore('meta').put({ key: 'deleted', value: result.deleted });
  });
  return result;
}

export async function importAll(data) {
  if (!data || !Array.isArray(data.decks) || !Array.isArray(data.cards)) throw new Error('Geen geldig back-upbestand');
  await tx(['decks', 'cards'], 'readwrite', (t) => {
    for (const d of data.decks) t.objectStore('decks').put(d);
    for (const c of data.cards) t.objectStore('cards').put(c);
  });
  return { decks: data.decks.length, cards: data.cards.length };
}
