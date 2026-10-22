// Synchroniseren tussen apparaten via GitHub (een geheime "gist").
// Werkt ook als de school Google-apps blokkeert. Nodig: een GitHub-sleutel
// (personal access token) met alleen het recht "gist"; die staat alleen op
// dit apparaat en gaat rechtstreeks naar GitHub.
import * as db from './db.js';
import { mergeData } from './merge.js';

const API = 'https://api.github.com';
const FILE_NAME = 'woordjes-sync.json';

export class BadToken extends Error {
  constructor() {
    super('De GitHub-sleutel klopt niet of is verlopen. Vul hem opnieuw in bij Instellingen.');
  }
}

async function gh(path, token, opts = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      ...opts,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch {
    throw new Error('GitHub is niet bereikbaar. Ben je online?');
  }
  if (res.status === 401) throw new BadToken();
  if (!res.ok) {
    let message = '';
    try {
      message = (await res.json()).message || '';
    } catch {
      /* geen uitleg van GitHub */
    }
    // Te vaak achter elkaar: GitHub remt af. Even wachten en later opnieuw.
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    const retry = Number(res.headers.get('retry-after')) * 1000;
    if (res.status === 429 || ((res.status === 403 || res.status === 422) && (/rate limit|too many|abuse/i.test(message) || res.headers.get('x-ratelimit-remaining') === '0'))) {
      const until = reset > Date.now() ? reset : Date.now() + (retry || 10 * 60_000);
      throw new RateLimited(until);
    }
    let text = `GitHub gaf een fout (${res.status}${message ? `: ${message}` : ''}).`;
    if (res.status === 403) text = `GitHub weigert de toegang${message ? ` (${message})` : ''}. Heeft de sleutel het recht "gist"?`;
    if (res.status === 404) text = 'Niet gevonden bij GitHub.';
    const err = new Error(text);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export class RateLimited extends Error {
  constructor(until) {
    const min = Math.max(1, Math.round((until - Date.now()) / 60_000));
    super(`GitHub: even te vaak gesynchroniseerd. Het gaat vanzelf weer over ± ${min} ${min === 1 ? 'minuut' : 'minuten'}.`);
    this.until = until;
  }
}

// Zelfde gegevens? (volgorde en tijdstip van synchroniseren tellen niet mee)
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical).sort((a, b) => (a.id || '').localeCompare(b.id || '') || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}
const sameData = (a, b) =>
  JSON.stringify(canonical({ decks: a.decks || [], cards: a.cards || [], deleted: a.deleted || {}, prefs: a.prefs || {} })) ===
  JSON.stringify(canonical({ decks: b.decks || [], cards: b.cards || [], deleted: b.deleted || {}, prefs: b.prefs || {} }));

// De gist met onze gegevens zoeken (of null).
async function findGist(token) {
  for (let page = 1; page <= 10; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`, token);
    const hit = list.find((g) => g.files && g.files[FILE_NAME]);
    if (hit) return hit.id;
    if (list.length < 100) return null;
  }
  return null;
}

async function readGist(token, id) {
  const gist = await gh(`/gists/${id}`, token);
  const file = gist.files && gist.files[FILE_NAME];
  if (!file) return {};
  // Grote bestanden geeft de API afgekort; dan het hele bestand apart ophalen.
  const text = file.truncated ? await (await fetch(file.raw_url, { cache: 'no-store' })).text() : file.content;
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const payload = (data) => ({
  files: { [FILE_NAME]: { content: JSON.stringify({ app: 'woordjes', version: 1, synced: new Date().toISOString(), ...data }) } },
});

let running = null;

// Gegevens van dit apparaat en GitHub samenvoegen en op beide plekken opslaan.
export function syncGist(token, { interactive = false } = {}) {
  if (!token) return Promise.reject(new BadToken());
  if (!running) {
    running = (async () => {
      // Na afremmen door GitHub niet steeds opnieuw proberen (alleen als je zelf tikt).
      const pause = await db.getMeta('gistPauseUntil', 0);
      if (!interactive && pause > Date.now()) throw new RateLimited(pause);
      let id = await db.getMeta('gistId', null);
      let remote = {};
      if (id) {
        try {
          remote = await readGist(token, id);
        } catch (err) {
          if (err.status !== 404) throw err;
          id = null; // gist verwijderd: opnieuw zoeken of maken
        }
      }
      if (!id) {
        id = await findGist(token);
        if (id) remote = await readGist(token, id);
      }
      const merged = mergeData(await db.exportAll(), remote);
      const saved = await db.applySynced(merged);
      if (id) {
        // Alleen schrijven als er iets veranderd is: GitHub staat maar een
        // beperkt aantal wijzigingen per uur toe.
        if (!sameData(saved, remote)) await gh(`/gists/${id}`, token, { method: 'PATCH', body: JSON.stringify(payload(saved)) });
      } else {
        const gist = await gh('/gists', token, {
          method: 'POST',
          body: JSON.stringify({ description: 'Woordjes: synchroniseren tussen apparaten', public: false, ...payload(saved) }),
        });
        id = gist.id;
      }
      await db.setMeta('gistId', id);
      await db.setMeta('lastSync', Date.now());
      await db.setMeta('gistPauseUntil', 0);
      return { decks: saved.decks.length, cards: saved.cards.length };
    })()
      .catch(async (err) => {
        if (err instanceof RateLimited) await db.setMeta('gistPauseUntil', err.until);
        throw err;
      })
      .finally(() => {
        running = null;
      });
  }
  return running;
}
