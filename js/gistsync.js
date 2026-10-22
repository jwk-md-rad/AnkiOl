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
  if (res.status === 403 || res.status === 404) {
    const err = new Error(res.status === 404 ? 'Niet gevonden bij GitHub.' : 'GitHub weigert de toegang. Heeft de sleutel het recht "gist"?');
    err.status = res.status;
    throw err;
  }
  if (!res.ok) throw new Error(`GitHub gaf een fout (${res.status}).`);
  return res.json();
}

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
export function syncGist(token) {
  if (!token) return Promise.reject(new BadToken());
  if (!running) {
    running = (async () => {
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
        await gh(`/gists/${id}`, token, { method: 'PATCH', body: JSON.stringify(payload(saved)) });
      } else {
        const gist = await gh('/gists', token, {
          method: 'POST',
          body: JSON.stringify({ description: 'Woordjes: synchroniseren tussen apparaten', public: false, ...payload(saved) }),
        });
        id = gist.id;
      }
      await db.setMeta('gistId', id);
      await db.setMeta('lastSync', Date.now());
      return { decks: saved.decks.length, cards: saved.cards.length };
    })().finally(() => {
      running = null;
    });
  }
  return running;
}
