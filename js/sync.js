// Synchroniseren tussen apparaten via Google Drive.
// De gegevens staan in de verborgen app-map van Drive ("appDataFolder"): alleen
// deze app kan erbij, en in je gewone Drive zie je het bestand niet.
import * as db from './db.js';
import { mergeData } from './merge.js';

const GIS_URL = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'woordjes-sync.json';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_KEY = 'woordjes-google-token';

export class NeedsLogin extends Error {
  constructor() {
    super('Log opnieuw in bij Google om te synchroniseren.');
  }
}

export function preloadGoogle() {
  loadGis().catch(() => {});
}

let gisPromise = null;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_URL;
    s.onload = resolve;
    s.onerror = () => {
      gisPromise = null;
      reject(new Error('Kon Google-inloggen niet laden. Ben je online?'));
    };
    document.head.appendChild(s);
  });
  return gisPromise;
}

function storedToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY));
    return t && t.expires > Date.now() + 60_000 ? t.token : null;
  } catch {
    return null;
  }
}

export const hasValidToken = () => Boolean(storedToken());

// Inloggen (opent een Google-venster). Moet starten vanuit een tik of klik.
export async function signIn(clientId) {
  if (!clientId) throw new Error('Vul eerst de Google Client ID in bij Instellingen.');
  await loadGis();
  const token = await new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      prompt: '',
      callback: (res) => (res.error ? reject(new Error(`Inloggen mislukt: ${res.error}`)) : resolve(res)),
      error_callback: (err) => reject(new Error(err.type === 'popup_closed' ? 'Inloggen afgebroken.' : `Inloggen mislukt: ${err.type}`)),
    });
    client.requestAccessToken();
  });
  localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: token.access_token, expires: Date.now() + token.expires_in * 1000 }));
  return token.access_token;
}

export async function signOut() {
  const token = storedToken();
  localStorage.removeItem(TOKEN_KEY);
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token, () => {});
}

async function drive(url, token, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    throw new NeedsLogin();
  }
  if (!res.ok) throw new Error(`Google Drive gaf een fout (${res.status}).`);
  return res;
}

async function findFile(token) {
  const q = encodeURIComponent(`name='${FILE_NAME}'`);
  const res = await drive(`${API}/files?spaces=appDataFolder&q=${q}&fields=files(id)`, token);
  const { files } = await res.json();
  return files && files.length ? files[0].id : null;
}

async function upload(token, fileId, data) {
  const body = JSON.stringify(data);
  if (fileId) {
    await drive(`${UPLOAD}/files/${fileId}?uploadType=media`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return;
  }
  const boundary = `woordjes${Date.now()}`;
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] }) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  await drive(`${UPLOAD}/files?uploadType=multipart`, token, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
}

let running = null;

// Gegevens van dit apparaat en Drive samenvoegen en op beide plekken opslaan.
// interactive: mag een Google-venster openen als er (nog) geen geldige sessie is.
export function syncNow({ clientId, interactive = false } = {}) {
  if (!running) {
    running = (async () => {
      let token = storedToken();
      if (!token) {
        if (!interactive) throw new NeedsLogin();
        token = await signIn(clientId);
      }
      const fileId = await findFile(token);
      const remote = fileId ? await (await drive(`${API}/files/${fileId}?alt=media`, token)).json() : {};
      const merged = mergeData(await db.exportAll(), remote);
      const saved = await db.applySynced(merged);
      await upload(token, fileId, { app: 'woordjes', version: 1, synced: new Date().toISOString(), ...saved });
      await db.setMeta('lastSync', Date.now());
      return { decks: saved.decks.length, cards: saved.cards.length };
    })().finally(() => {
      running = null;
    });
  }
  return running;
}
