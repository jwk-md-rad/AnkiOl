import * as db from './db.js';
import { previewLabels, AGAIN, HARD, GOOD, EASY, formatMs } from './srs.js';
import { Session, countDue } from './session.js';
import { checkAnswer, normalize } from './check.js';
import { pairsFromText } from './parse.js';
import { loadImage, toCanvas, canvasToBase64Jpeg } from './image.js';

const $app = document.getElementById('app');
const LANGS = { en: 'Engels', nl: 'Nederlands', fr: 'Frans', de: 'Duits' };
const VOICE_LANG = { en: 'en-GB', nl: 'nl-NL', fr: 'fr-FR', de: 'de-DE' };
const DIRS = { fwd: ['fwd'], rev: ['rev'], both: ['fwd', 'rev'] };

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let cleanup = () => {};

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function render(html) {
  $app.innerHTML = html;
  window.scrollTo(0, 0);
}

const settings = {
  async get() {
    return {
      apiKey: await db.getMeta('apiKey', ''),
      newPerDay: await db.getMeta('newPerDay', 20),
      speak: await db.getMeta('speak', true),
    };
  },
};

function speak(text, lang) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = VOICE_LANG[lang] || lang;
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

// Hoeveel nieuwe kaarten er vandaag nog geleerd mogen worden (per hoofdstuk).
async function newLeftToday(deckId, perDay) {
  const today = new Date().toDateString();
  const rec = await db.getMeta(`new:${deckId}`, null);
  const used = rec && rec.day === today ? rec.count : 0;
  return Math.max(0, perDay - used);
}

async function countNewToday(deckId) {
  const today = new Date().toDateString();
  const rec = await db.getMeta(`new:${deckId}`, null);
  const count = rec && rec.day === today ? rec.count + 1 : 1;
  await db.setMeta(`new:${deckId}`, { day: today, count });
}

// ---------- Router ----------

async function route() {
  cleanup();
  cleanup = () => {};
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    if (!parts.length) return await homeView();
    if (parts[0] === 'settings') return await settingsView();
    if (parts[0] === 'uitleg') return await helpView(Number(parts[1]) || 0);
    if (parts[0] === 'deck' && parts[1]) {
      const deck = await db.getDeck(parts[1]);
      if (!deck) return (location.hash = '#/');
      if (parts[2] === 'photo') return await photoView(deck);
      if (parts[2] === 'add') return await addView(deck);
      if (parts[2] === 'study') return await studySetupView(deck);
      return await deckView(deck);
    }
    location.hash = '#/';
  } catch (e) {
    console.error(e);
    render(`<div class="panel error">Er ging iets mis: ${esc(e.message)}</div>`);
  }
}

window.addEventListener('hashchange', route);

// ---------- Home ----------

async function homeView() {
  const decks = await db.listDecks();
  // Eerste keer: meteen de uitleg laten zien.
  if (!decks.length && !(await db.getMeta('seenHelp', false))) return (location.hash = '#/uitleg');
  const cards = await db.allCards();
  const now = Date.now();
  const rows = decks
    .map((d) => {
      const dc = cards.filter((c) => c.deckId === d.id);
      const c = countDue(dc, ['fwd', 'rev'], now);
      return `
      <a class="deck" href="#/deck/${d.id}">
        <div>
          <div class="deck-name">${esc(d.name)}</div>
          <div class="muted">${dc.length} woordjes · ${esc(LANGS[d.frontLang])} ↔ ${esc(LANGS[d.backLang])}</div>
        </div>
        <div class="counts">
          <span class="c-new" title="Nieuw">${c.fresh}</span>
          <span class="c-learn" title="Aan het leren">${c.learn}</span>
          <span class="c-review" title="Te herhalen">${c.review}</span>
        </div>
      </a>`;
    })
    .join('');

  render(`
    <section class="panel">
      <div class="row spread"><h2>Mijn hoofdstukken</h2><a href="#/uitleg" class="help-link">❓ Hoe werkt het?</a></div>
      ${rows || '<p class="muted">Nog geen hoofdstukken. Maak hieronder je eerste hoofdstuk aan.</p>'}
      <form id="newDeck" class="row">
        <input name="name" placeholder="Naam, bv. Engels H4" required maxlength="80">
        <button class="primary">+ Nieuw hoofdstuk</button>
      </form>
      <p class="legend muted"><span class="c-new">nieuw</span> <span class="c-learn">aan het leren</span> <span class="c-review">te herhalen</span></p>
    </section>
    <section class="panel">
      <h2>Back-up</h2>
      <p class="muted">Je woordjes staan alleen op deze Chromebook. Maak af en toe een back-up (bijv. naar Google Drive).</p>
      <div class="row">
        <button id="export">Back-up downloaden</button>
        <label class="button">Back-up terugzetten<input id="import" type="file" accept=".json,application/json" hidden></label>
      </div>
    </section>`);

  document.getElementById('newDeck').onsubmit = async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    const deck = await db.saveDeck({ name });
    location.hash = `#/deck/${deck.id}`;
  };
  document.getElementById('export').onclick = async () => {
    const data = await db.exportAll();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `woordjes-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  document.getElementById('import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const res = await db.importAll(JSON.parse(await file.text()));
      toast(`${res.decks} hoofdstukken en ${res.cards} woordjes teruggezet`, 'ok');
      route();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
}

// ---------- Deck ----------

async function deckView(deck) {
  const cards = (await db.listCards(deck.id)).sort((a, b) => b.created - a.created);
  const c = countDue(cards, ['fwd', 'rev']);
  const langOpts = (sel) =>
    Object.entries(LANGS)
      .map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`)
      .join('');

  render(`
    <nav class="crumbs"><a href="#/">← Hoofdstukken</a></nav>
    <section class="panel">
      <div class="row spread">
        <h2>${esc(deck.name)}</h2>
        <div class="counts big">
          <span class="c-new" title="Nieuw">${c.fresh}</span>
          <span class="c-learn" title="Aan het leren">${c.learn}</span>
          <span class="c-review" title="Te herhalen">${c.review}</span>
        </div>
      </div>
      <div class="actions">
        <a class="button primary big" href="#/deck/${deck.id}/study">▶ Overhoren</a>
        <a class="button big" href="#/deck/${deck.id}/photo">📷 Foto → kaartjes</a>
        <a class="button big" href="#/deck/${deck.id}/add">✎ Typen / plakken</a>
      </div>
    </section>
    <section class="panel">
      <div class="row spread">
        <h3>Woordjes (${cards.length})</h3>
        <input id="search" type="search" placeholder="Zoeken…">
      </div>
      <table class="cards">
        <thead><tr><th>${esc(LANGS[deck.frontLang])}</th><th>${esc(LANGS[deck.backLang])}</th><th>Volgende keer</th><th></th></tr></thead>
        <tbody>
        ${cards
          .map(
            (card) => `
          <tr data-id="${card.id}">
            <td><input class="f" value="${esc(card.front)}"></td>
            <td><input class="b" value="${esc(card.back)}"></td>
            <td class="muted">${nextLabel(card)}</td>
            <td><button class="icon del" title="Verwijderen">✕</button></td>
          </tr>`
          )
          .join('')}
        </tbody>
      </table>
      ${cards.length ? '' : '<p class="muted">Nog geen woordjes. Voeg ze toe met een foto of door ze te typen.</p>'}
    </section>
    <section class="panel">
      <h3>Instellingen van dit hoofdstuk</h3>
      <form id="deckForm" class="grid">
        <label>Naam <input name="name" value="${esc(deck.name)}" required></label>
        <label>Voorkant <select name="frontLang">${langOpts(deck.frontLang)}</select></label>
        <label>Achterkant <select name="backLang">${langOpts(deck.backLang)}</select></label>
        <div class="row"><button>Opslaan</button><button type="button" id="delDeck" class="danger">Hoofdstuk verwijderen</button></div>
      </form>
    </section>`);

  const byId = Object.fromEntries(cards.map((x) => [x.id, x]));
  const tbody = $app.querySelector('tbody');
  tbody.addEventListener('change', async (e) => {
    const tr = e.target.closest('tr');
    const card = byId[tr.dataset.id];
    card.front = tr.querySelector('.f').value.trim();
    card.back = tr.querySelector('.b').value.trim();
    await db.putCards([card]);
    toast('Opgeslagen', 'ok');
  });
  tbody.addEventListener('click', async (e) => {
    if (!e.target.classList.contains('del')) return;
    const tr = e.target.closest('tr');
    await db.deleteCard(tr.dataset.id);
    tr.remove();
  });
  document.getElementById('search').oninput = (e) => {
    const q = normalize(e.target.value);
    for (const tr of tbody.rows) {
      const card = byId[tr.dataset.id];
      tr.hidden = q && !normalize(`${card.front} ${card.back}`).includes(q);
    }
  };
  document.getElementById('deckForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    await db.saveDeck({ ...deck, name: f.name.value.trim(), frontLang: f.frontLang.value, backLang: f.backLang.value });
    toast('Opgeslagen', 'ok');
    route();
  };
  document.getElementById('delDeck').onclick = async () => {
    if (!confirm(`Hoofdstuk "${deck.name}" met ${cards.length} woordjes definitief verwijderen?`)) return;
    await db.deleteDeck(deck.id);
    location.hash = '#/';
  };
}

function nextLabel(card) {
  const states = [card.fwd, card.rev].filter((s) => s.state !== 'new');
  if (!states.length) return 'nieuw';
  const due = Math.min(...states.map((s) => s.due));
  const diff = due - Date.now();
  if (diff <= 0) return 'nu';
  if (diff < 24 * 3600 * 1000) return `over ${formatMs(diff)}`;
  return new Date(due).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
}

// ---------- Kaartjes controleren (gedeeld door foto en plakken) ----------

function reviewTable(deck, rows, existing) {
  const known = new Set(existing.map((c) => normalize(c.front)));
  for (const r of rows) {
    if (r.dup === undefined) r.dup = known.has(normalize(r.front));
    if (r.dup) r.ok = false;
  }
  const box = document.createElement('section');
  box.className = 'panel';
  const draw = () => {
    const n = rows.filter((r) => r.ok && r.front.trim() && r.back.trim()).length;
    box.innerHTML = `
      <div class="row spread">
        <h3>Controleer de kaartjes</h3>
        <div class="row">
          <button type="button" class="swap">⇄ Kolommen wisselen</button>
          <button type="button" class="addrow">+ Regel</button>
        </div>
      </div>
      <p class="muted">Vink uit wat je niet wilt leren en verbeter fouten. Grijze regels konden niet automatisch gesplitst worden of staan al in dit hoofdstuk.</p>
      <table class="cards review">
        <thead><tr><th></th><th>${esc(LANGS[deck.frontLang])}</th><th>${esc(LANGS[deck.backLang])}</th><th></th></tr></thead>
        <tbody>
          ${rows
            .map(
              (r, i) => `
            <tr data-i="${i}" class="${r.ok ? '' : 'off'}">
              <td><input type="checkbox" class="ok" ${r.ok ? 'checked' : ''}></td>
              <td><input class="f" value="${esc(r.front)}"></td>
              <td><input class="b" value="${esc(r.back)}">${r.dup ? '<small class="muted">staat er al in</small>' : ''}</td>
              <td><button type="button" class="icon del" title="Weghalen">✕</button></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
      <div class="row end">
        <button type="button" class="primary big save" ${n ? '' : 'disabled'}>${n} kaartjes opslaan</button>
      </div>`;
  };
  draw();
  box.addEventListener('input', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const r = rows[tr.dataset.i];
    if (e.target.classList.contains('ok')) r.ok = e.target.checked;
    if (e.target.classList.contains('f')) r.front = e.target.value;
    if (e.target.classList.contains('b')) {
      r.back = e.target.value;
      if (r.back.trim() && !r.dup) r.ok = true;
    }
    tr.classList.toggle('off', !r.ok);
    tr.querySelector('.ok').checked = r.ok;
    const n = rows.filter((x) => x.ok && x.front.trim() && x.back.trim()).length;
    const btn = box.querySelector('.save');
    btn.textContent = `${n} kaartjes opslaan`;
    btn.disabled = !n;
  });
  box.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.classList.contains('del')) {
      rows.splice(Number(t.closest('tr').dataset.i), 1);
      draw();
    } else if (t.classList.contains('swap')) {
      for (const r of rows) [r.front, r.back] = [r.back, r.front];
      draw();
    } else if (t.classList.contains('addrow')) {
      rows.push({ front: '', back: '', ok: true, dup: false });
      draw();
      box.querySelector('tbody tr:last-child .f').focus();
    } else if (t.classList.contains('save')) {
      const keep = rows.filter((r) => r.ok && r.front.trim() && r.back.trim());
      await db.putCards(keep.map((r) => db.makeCard(deck.id, r.front.trim(), r.back.trim())));
      toast(`${keep.length} kaartjes toegevoegd`, 'ok');
      location.hash = `#/deck/${deck.id}`;
    }
  });
  return box;
}

// ---------- Typen / plakken ----------

async function addView(deck) {
  const existing = await db.listCards(deck.id);
  render(`
    <nav class="crumbs"><a href="#/deck/${deck.id}">← ${esc(deck.name)}</a></nav>
    <section class="panel">
      <h2>Woordjes typen of plakken</h2>
      <p class="muted">Eén woord of zin per regel, met een streepje, = of tab ertussen. Bijvoorbeeld:<br>
      <code>house - huis</code><br><code>to run = rennen</code></p>
      <textarea id="text" rows="10" placeholder="${esc(LANGS[deck.frontLang])} - ${esc(LANGS[deck.backLang])}"></textarea>
      <div class="row end"><button id="go" class="primary">Verder</button></div>
    </section>
    <div id="review"></div>`);
  document.getElementById('go').onclick = () => {
    const rows = pairsFromText(document.getElementById('text').value);
    const target = document.getElementById('review');
    target.innerHTML = '';
    if (!rows.length) return toast('Geen woordjes gevonden', 'bad');
    target.appendChild(reviewTable(deck, rows, existing));
  };
}

// ---------- Foto → kaartjes ----------

async function photoView(deck) {
  const { apiKey } = await settings.get();
  const existing = await db.listCards(deck.id);
  let bitmap = null;
  let rotate = 0;
  let stream = null;

  render(`
    <nav class="crumbs"><a href="#/deck/${deck.id}">← ${esc(deck.name)}</a></nav>
    <section class="panel">
      <h2>Foto → kaartjes</h2>
      <p class="muted">Maak een scherpe, rechte foto van de woordenlijst in je leerboek, of kies een foto die je al hebt.</p>
      <div class="row">
        <label class="button big">🖼 Foto kiezen<input id="file" type="file" accept="image/*" hidden></label>
        <button id="cam" class="big">📷 Camera</button>
      </div>
      <div id="camBox" hidden>
        <video id="video" autoplay playsinline></video>
        <div class="row"><button id="snap" class="primary big">Foto maken</button><button id="camStop">Annuleren</button></div>
      </div>
      <div id="preview" hidden>
        <canvas id="canvas"></canvas>
        <div class="row">
          <button id="rotL">⟲ Draai</button><button id="rotR">⟳ Draai</button>
        </div>
        <div class="row">
          <label>Herkennen met
            <select id="method">
              <option value="claude" ${apiKey ? 'selected' : 'disabled'}>Claude AI (beste resultaat)${apiKey ? '' : ' – stel eerst een API-sleutel in'}</option>
              <option value="ocr" ${apiKey ? '' : 'selected'}>Gratis tekstherkenning (OCR)</option>
            </select>
          </label>
          <button id="run" class="primary big">Maak kaartjes</button>
        </div>
        <div id="progress" class="muted"></div>
      </div>
    </section>
    <div id="review"></div>`);

  const canvas = document.getElementById('canvas');
  const drawPreview = () => {
    const c = toCanvas(bitmap, 1200, { rotate });
    canvas.width = c.width;
    canvas.height = c.height;
    canvas.getContext('2d').drawImage(c, 0, 0);
    document.getElementById('preview').hidden = false;
  };
  const stopCam = () => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    document.getElementById('camBox').hidden = true;
  };
  cleanup = stopCam;

  document.getElementById('file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    bitmap = await loadImage(file);
    rotate = 0;
    drawPreview();
  };
  document.getElementById('cam').onclick = async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      document.getElementById('video').srcObject = stream;
      document.getElementById('camBox').hidden = false;
    } catch {
      toast('Camera niet beschikbaar', 'bad');
    }
  };
  document.getElementById('camStop').onclick = stopCam;
  document.getElementById('snap').onclick = async () => {
    const video = document.getElementById('video');
    bitmap = await createImageBitmap(video);
    rotate = 0;
    stopCam();
    drawPreview();
  };
  document.getElementById('rotL').onclick = () => {
    rotate = (rotate + 270) % 360;
    drawPreview();
  };
  document.getElementById('rotR').onclick = () => {
    rotate = (rotate + 90) % 360;
    drawPreview();
  };
  document.getElementById('run').onclick = async (e) => {
    const btn = e.target;
    const progress = document.getElementById('progress');
    const method = document.getElementById('method').value;
    btn.disabled = true;
    document.getElementById('review').innerHTML = '';
    try {
      let rows;
      if (method === 'claude') {
        progress.textContent = 'Claude leest de foto… (duurt ongeveer 10–30 seconden)';
        const { claudePairs } = await import('./claude.js');
        const jpeg = canvasToBase64Jpeg(toCanvas(bitmap, 1800, { rotate }));
        rows = await claudePairs(jpeg, apiKey, { frontLang: deck.frontLang, backLang: deck.backLang });
      } else {
        progress.textContent = 'Tekstherkenning laden… (de eerste keer kan dit even duren)';
        const { ocrPairs } = await import('./ocr.js');
        const res = await ocrPairs(toCanvas(bitmap, 2400, { rotate, grayscale: true }), (m) => {
          if (m.status === 'recognizing text') progress.textContent = `Tekst herkennen… ${Math.round(m.progress * 100)}%`;
          else if (m.status) progress.textContent = `${m.status}…`;
        });
        rows = res.rows;
      }
      progress.textContent = rows.length ? `${rows.length} regels gevonden.` : 'Geen woordjes gevonden. Probeer een scherpere of rechtere foto.';
      if (rows.length) document.getElementById('review').appendChild(reviewTable(deck, rows, existing));
    } catch (err) {
      console.error(err);
      progress.textContent = '';
      toast(friendlyError(err), 'bad');
    } finally {
      btn.disabled = false;
    }
  };
}

function friendlyError(err) {
  const status = err && err.status;
  if (status === 401) return 'De API-sleutel klopt niet. Controleer hem bij Instellingen.';
  if (status === 429) return 'Even te veel verzoeken. Probeer het over een minuut opnieuw.';
  if (status === 400 && /credit/i.test(err.message)) return 'Je API-tegoed is op.';
  if (!navigator.onLine) return 'Je bent offline. Foto’s herkennen werkt alleen met internet.';
  return err.message || 'Er ging iets mis.';
}

// ---------- Overhoren ----------

async function studySetupView(deck) {
  const cards = await db.listCards(deck.id);
  const { newPerDay } = await settings.get();
  const newLeft = await newLeftToday(deck.id, newPerDay);
  const last = await db.getMeta(`study:${deck.id}`, { mode: 'flip', dir: 'fwd' });
  const f = LANGS[deck.frontLang];
  const b = LANGS[deck.backLang];

  render(`
    <nav class="crumbs"><a href="#/deck/${deck.id}">← ${esc(deck.name)}</a></nav>
    <section class="panel">
      <h2>Overhoren: ${esc(deck.name)}</h2>
      <form id="setup" class="setup">
        <fieldset>
          <legend>Hoe wil je overhoren?</legend>
          <label class="choice"><input type="radio" name="mode" value="flip" ${last.mode === 'flip' ? 'checked' : ''}>
            <span><b>Omdraaien</b><br><small>Bedenk het antwoord, draai om en beoordeel jezelf.</small></span></label>
          <label class="choice"><input type="radio" name="mode" value="type" ${last.mode === 'type' ? 'checked' : ''}>
            <span><b>Intypen</b><br><small>Typ het antwoord; de app controleert het.</small></span></label>
        </fieldset>
        <fieldset>
          <legend>Richting</legend>
          <label class="choice"><input type="radio" name="dir" value="fwd" ${last.dir === 'fwd' ? 'checked' : ''}><span>${esc(f)} → ${esc(b)}</span></label>
          <label class="choice"><input type="radio" name="dir" value="rev" ${last.dir === 'rev' ? 'checked' : ''}><span>${esc(b)} → ${esc(f)}</span></label>
          <label class="choice"><input type="radio" name="dir" value="both" ${last.dir === 'both' ? 'checked' : ''}><span>Beide richtingen</span></label>
        </fieldset>
        <p id="summary" class="muted"></p>
        <div class="row">
          <label class="inline"><input type="checkbox" name="cram"> Alles oefenen (ook wat nog niet aan de beurt is, bijv. vlak voor een toets)</label>
        </div>
        <button class="primary big">Start</button>
      </form>
    </section>`);

  const form = document.getElementById('setup');
  const update = () => {
    const c = countDue(cards, DIRS[form.dir.value]);
    const fresh = Math.min(c.fresh, newLeft);
    document.getElementById('summary').innerHTML = form.cram.checked
      ? `Toetsmodus: alle ${cards.length} woordjes komen langs. Je planning wordt niet aangepast.`
      : `Vandaag: <span class="c-new">${fresh} nieuw</span> · <span class="c-learn">${c.learn} aan het leren</span> · <span class="c-review">${c.review} herhalen</span>` +
        (c.fresh > fresh ? ` <br><small>Nieuwe woordjes per dag: ${newPerDay} (aan te passen bij Instellingen).</small>` : '');
  };
  form.onchange = update;
  update();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const opts = { mode: form.mode.value, dir: form.dir.value };
    await db.setMeta(`study:${deck.id}`, opts);
    studyView(deck, cards, { ...opts, cram: form.cram.checked, newLeft });
  };
}

function cramSession(cards, dirs) {
  // Toetsmodus: aparte kopieën, zodat de echte planning onaangetast blijft.
  const copies = cards.map((c) => ({
    ...c,
    fwd: { ...c.fwd, state: 'new', step: 0 },
    rev: { ...c.rev, state: 'new', step: 0 },
  }));
  return new Session(copies, dirs, { newLimit: Infinity, oneDirPerCard: false });
}

async function studyView(deck, cards, { mode, dir, cram, newLeft }) {
  const { speak: speakOn } = await settings.get();
  const dirs = DIRS[dir];
  const session = cram ? cramSession(cards, dirs) : new Session(cards, dirs, { newLimit: newLeft });
  const langOf = (d, side) => (d === 'fwd') === (side === 'q') ? deck.frontLang : deck.backLang;

  let item = null;
  let phase = 'question';
  let suggested = GOOD;

  render(`
    <nav class="crumbs"><a href="#/deck/${deck.id}">← Stoppen</a><span id="counts" class="counts"></span></nav>
    <section class="study panel" id="study"></section>`);
  const $s = document.getElementById('study');

  const showCounts = () => {
    const c = session.counts();
    document.getElementById('counts').innerHTML = `
      <span class="c-new" title="Nieuw">${c.fresh}</span>
      <span class="c-learn" title="Aan het leren">${c.learn}</span>
      <span class="c-review" title="Te herhalen">${c.review}</span>`;
  };

  const question = () => (item.dir === 'fwd' ? item.card.front : item.card.back);
  const answerText = () => (item.dir === 'fwd' ? item.card.back : item.card.front);

  const speakBtn = (text, lang) =>
    speakOn && 'speechSynthesis' in window
      ? `<button class="icon speak" data-text="${esc(text)}" data-lang="${lang}" title="Voorlezen">🔊</button>`
      : '';

  function next() {
    item = session.next();
    showCounts();
    if (!item) return done();
    phase = 'question';
    const qLang = langOf(item.dir, 'q');
    const aLang = langOf(item.dir, 'a');
    const isNew = item.card[item.dir].state === 'new';
    $s.innerHTML = `
      <div class="card-label muted">${esc(LANGS[qLang])} → ${esc(LANGS[aLang])}${isNew ? ' · <span class="c-new">nieuw</span>' : ''}</div>
      <div class="q">${esc(question())} ${speakBtn(question(), qLang)}</div>
      ${
        mode === 'type'
          ? `<form id="typeForm" class="type"><input id="typed" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Typ je antwoord (${esc(LANGS[aLang])})"><button class="primary">Controleer</button></form>`
          : `<button id="flip" class="primary big">Toon antwoord <kbd>spatie</kbd></button>`
      }
      <div id="answer"></div>`;
    if (mode === 'type') {
      const input = document.getElementById('typed');
      input.focus();
      document.getElementById('typeForm').onsubmit = (e) => {
        e.preventDefault();
        reveal(input.value);
      };
    } else {
      document.getElementById('flip').onclick = () => reveal(null);
    }
    if (speakOn && qLang !== 'nl') speak(question(), qLang);
  }

  function reveal(typed) {
    phase = 'answer';
    const aLang = langOf(item.dir, 'a');
    let verdict = '';
    suggested = GOOD;
    if (typed !== null) {
      const res = checkAnswer(typed, answerText());
      suggested = res === 'correct' ? GOOD : res === 'almost' ? HARD : AGAIN;
      const label = { correct: '✓ Goed!', almost: '≈ Bijna goed (let op de spelling)', wrong: '✗ Helaas' }[res];
      verdict = `<div class="verdict ${res}">${label}${res !== 'correct' ? `<div class="muted">Jij typte: <s>${esc(typed) || '(niets)'}</s></div>` : ''}</div>`;
      document.getElementById('typeForm').remove();
    } else {
      document.getElementById('flip').remove();
    }
    const labels = previewLabels(item.card[item.dir]);
    const btn = (r, name, cls) =>
      `<button class="rate ${cls} ${typed !== null && r === suggested ? 'suggested' : ''}" data-r="${r}">${name}<small>${labels[r]}</small><kbd>${r}</kbd></button>`;
    document.getElementById('answer').innerHTML = `
      ${verdict}
      <hr>
      <div class="a">${esc(answerText())} ${speakBtn(answerText(), aLang)}</div>
      ${typed !== null ? '<p class="muted center">Enter = voorgestelde knop. Klopt het oordeel niet? Kies zelf.</p>' : '<p class="muted center">Hoe goed wist je het?</p>'}
      <div class="rates">
        ${btn(AGAIN, 'Opnieuw', 'again')}${btn(HARD, 'Moeilijk', 'hard')}${btn(GOOD, 'Goed', 'good')}${btn(EASY, 'Makkelijk', 'easy')}
      </div>`;
    if (speakOn && aLang !== 'nl' && typed === null) speak(answerText(), aLang);
    $s.querySelector('.rates').onclick = (e) => {
      const b = e.target.closest('.rate');
      if (b) rate(Number(b.dataset.r));
    };
    if (typed !== null) $s.querySelector('.rate.suggested').focus();
  }

  async function rate(r) {
    if (phase !== 'answer') return;
    phase = 'saving';
    const { wasNew } = session.answer(item, r);
    if (!cram) {
      await db.putCards([item.card]);
      if (wasNew) await countNewToday(deck.id);
    }
    next();
  }

  function done() {
    const left = session.items.filter(({ card, dir: d }) => card[d].state !== 'review');
    const soon = left.length ? Math.min(...left.map(({ card, dir: d }) => card[d].due)) - Date.now() : 0;
    const pct = session.stats.answered ? Math.round((1 - session.stats.again / session.stats.answered) * 100) : 0;
    $s.innerHTML = `
      <div class="done">
        <div class="big-emoji">🎉</div>
        <h2>Klaar voor nu!</h2>
        <p>${session.stats.answered} kaartjes beantwoord${session.stats.answered ? `, ${pct}% in één keer goed` : ''}.</p>
        ${left.length ? `<p class="muted">Nog ${left.length} kaartjes aan het leren; kom over ongeveer ${formatMs(soon)} terug.</p>` : '<p class="muted">Alles gedaan voor vandaag. Kom morgen terug voor de herhalingen!</p>'}
        <div class="row center"><a class="button primary" href="#/deck/${deck.id}">Terug naar hoofdstuk</a><a class="button" href="#/">Alle hoofdstukken</a></div>
      </div>`;
  }

  $s.addEventListener('click', (e) => {
    const sp = e.target.closest('.speak');
    if (sp) speak(sp.dataset.text, sp.dataset.lang);
  });

  const onKey = (e) => {
    if (!item) return;
    const typing = e.target.tagName === 'INPUT';
    if (phase === 'question' && mode === 'flip' && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      reveal(null);
    } else if (phase === 'answer' && !typing && ['1', '2', '3', '4'].includes(e.key)) {
      rate(Number(e.key));
    } else if (phase === 'answer' && e.key === 'Enter' && mode === 'type') {
      e.preventDefault();
      rate(suggested);
    } else if (phase === 'answer' && e.key === ' ' && mode === 'flip') {
      e.preventDefault();
      rate(GOOD);
    }
  };
  document.addEventListener('keydown', onKey);
  cleanup = () => {
    document.removeEventListener('keydown', onKey);
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  };
  next();
}

// ---------- Uitleg ----------

const HELP_STEPS = [
  {
    emoji: '👋',
    title: 'Hoi!',
    text: 'Met deze app leer je je woordjes. <b>Elke dag 10 minuten</b> = klaar voor de toets.',
  },
  {
    emoji: '📚',
    title: 'Maak een hoofdstuk',
    text: 'Typ een naam, bijvoorbeeld <b>Engels H4</b>.',
    demo: '<span class="demo-input">Engels H4</span><span class="demo-btn primary">+ Nieuw hoofdstuk</span>',
  },
  {
    emoji: '📷',
    title: 'Foto van je boek',
    text: 'Open je hoofdstuk. Tik op <b>Foto → kaartjes</b>.<br>Foto <b>recht</b> en <b>scherp</b>.',
    demo: '<span class="demo-btn">📷 Foto → kaartjes</span>',
  },
  {
    emoji: '✅',
    title: 'Klopt het?',
    text: 'Fout woord? Tik erop en verbeter.<br>Niet leren? Vinkje weg.',
    demo: '<span class="demo-check">☑ house · huis</span><span class="demo-check off">☐ Unit 4</span>',
  },
  {
    emoji: '▶️',
    title: 'Overhoren',
    text: 'Kies: <b>Omdraaien</b> (in je hoofd) of <b>Intypen</b>.',
    demo: '<span class="demo-btn primary">▶ Overhoren</span>',
  },
  {
    emoji: '🤔',
    title: 'Hoe goed wist je het?',
    text: 'Wees eerlijk! De app regelt de rest.',
    demo: `<div class="demo-rates">
      <span class="rate again">Opnieuw<small>wist ik niet</small></span>
      <span class="rate hard">Moeilijk<small>met moeite</small></span>
      <span class="rate good">Goed<small>wist ik</small></span>
      <span class="rate easy">Makkelijk<small>te makkelijk</small></span></div>`,
  },
  {
    emoji: '🔁',
    title: 'Waarom elke dag?',
    text: 'Weet je het? Dan komt het woord <b>later</b> terug.<br>Fout? Dan komt het <b>snel</b> terug.',
  },
  {
    emoji: '🚀',
    title: 'Toets morgen?',
    text: 'Vink <b>Alles oefenen</b> aan. Dan komen alle woordjes langs.',
    demo: '<span class="demo-check">☑ Alles oefenen</span>',
  },
  {
    emoji: '⌨️',
    title: 'Sneller met toetsen',
    text: '<kbd>spatie</kbd> = omdraaien<br><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> = knoppen',
  },
];

async function helpView(i) {
  i = Math.min(Math.max(0, i), HELP_STEPS.length - 1);
  const step = HELP_STEPS[i];
  const last = i === HELP_STEPS.length - 1;
  await db.setMeta('seenHelp', true);
  render(`
    <section class="panel help">
      <a href="#/" class="help-skip">Overslaan ✕</a>
      <div class="help-emoji">${step.emoji}</div>
      <h2>${step.title}</h2>
      <p class="help-text">${step.text}</p>
      ${step.demo ? `<div class="help-demo">${step.demo}</div>` : ''}
      <div class="help-dots">${HELP_STEPS.map((_, j) => `<a href="#/uitleg/${j}" class="${j === i ? 'on' : ''}" aria-label="Stap ${j + 1}"></a>`).join('')}</div>
      <div class="help-nav ${i ? '' : 'first'}">
        ${i ? `<a class="button big" href="#/uitleg/${i - 1}">←</a>` : ''}
        ${last ? '<a class="button primary big" href="#/">Aan de slag! 🚀</a>' : `<a class="button primary big" href="#/uitleg/${i + 1}">Volgende →</a>`}
      </div>
    </section>`);
  const onKey = (e) => {
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      location.hash = last ? '#/' : `#/uitleg/${i + 1}`;
    } else if (e.key === 'ArrowLeft' && i) {
      location.hash = `#/uitleg/${i - 1}`;
    }
  };
  document.addEventListener('keydown', onKey);
  cleanup = () => document.removeEventListener('keydown', onKey);
}

// ---------- Instellingen ----------

async function settingsView() {
  const s = await settings.get();
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
  render(`
    <nav class="crumbs"><a href="#/">← Hoofdstukken</a></nav>
    <section class="panel">
      <h2>Instellingen</h2>
      <form id="settings" class="grid">
        <label>Nieuwe woordjes per dag (per hoofdstuk)
          <input name="newPerDay" type="number" min="1" max="500" value="${s.newPerDay}">
        </label>
        <label class="inline"><input type="checkbox" name="speak" ${s.speak ? 'checked' : ''}> Woordjes voorlezen</label>
        <label>Anthropic API-sleutel (voor Claude AI foto-herkenning)
          <input name="apiKey" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(s.apiKey)}">
        </label>
        <p class="muted small">Optioneel. Zonder sleutel gebruikt de app gratis tekstherkenning. Met een sleutel leest Claude de foto en maakt nettere kaartjes
        (kost een paar cent per foto). Een sleutel maak je op <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>.
        De sleutel wordt alleen op deze Chromebook bewaard en gaat rechtstreeks naar Anthropic.</p>
        <button class="primary">Opslaan</button>
      </form>
    </section>
    <section class="panel">
      <h3>Opslag</h3>
      <p class="muted">${persisted ? '✓ Je woordjes worden permanent bewaard.' : 'Chrome kan gegevens opruimen als de schijf vol raakt. Installeer de app (⊕ in de adresbalk) en maak regelmatig een back-up.'}</p>
    </section>`);
  document.getElementById('settings').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    await db.setMeta('newPerDay', Math.max(1, Number(f.newPerDay.value) || 20));
    await db.setMeta('speak', f.speak.checked);
    await db.setMeta('apiKey', f.apiKey.value.trim());
    toast('Instellingen opgeslagen', 'ok');
  };
}

// ---------- Start ----------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
route();
