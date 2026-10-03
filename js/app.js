import * as db from './db.js';
import { previewLabels, AGAIN, HARD, GOOD, EASY, formatMs } from './srs.js';
import { Session, countDue, nextVariant, needsMoreVariants, addVariants } from './session.js';
import { checkAnswer, normalize } from './check.js';
import { pairsFromText } from './parse.js';
import { loadImage, toCanvas, canvasToBase64Jpeg, isHeic, isImageFile } from './image.js';
import { STONE_TYPES } from './claude.js';

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

// Claude-modellen voor foto → kaartjes (kosten: schatting per bladzijde).
const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', note: 'beste resultaat, ± 5–10 cent per bladzijde' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', note: 'goedkoper, ± 2–5 cent per bladzijde' },
];
const modelName = (id) => (CLAUDE_MODELS.find((m) => m.id === id) || CLAUDE_MODELS[0]).name;

const settings = {
  async get() {
    return {
      apiKey: await db.getMeta('apiKey', ''),
      model: await db.getMeta('model', CLAUDE_MODELS[0].id),
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
      if (parts[2] === 'stone') return await photoView(deck, 'stone');
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
        <a class="button big" href="#/deck/${deck.id}/stone">📘 Stone → oefeningen</a>
        ${cards.some((c) => c.kind === 'stone') ? '<button id="moreStone" class="big">🔄 Nieuwe Stone-zinnen</button>' : ''}
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
            ${
              card.kind === 'stone'
                ? `<td class="stone-cell"><span class="badge">📘 ${esc(STONE_TYPES[card.type])}</span> ${esc(card.front)}</td><td class="stone-cell">${esc(card.back)} <small class="muted">(${card.variants.length} varianten)</small></td>`
                : `<td><input class="f" value="${esc(card.front)}"></td><td><input class="b" value="${esc(card.back)}"></td>`
            }
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
  const more = document.getElementById('moreStone');
  if (more) {
    more.onclick = async () => {
      more.disabled = true;
      more.textContent = '🔄 Nieuwe zinnen maken…';
      try {
        const added = await topUpStones(cards.filter((c) => c.kind === 'stone'));
        toast(added ? `${added} nieuwe zinnen toegevoegd` : 'Geen nieuwe zinnen gemaakt', added ? 'ok' : 'bad');
      } catch (err) {
        console.error(err);
        toast(friendlyError(err), 'bad');
      }
      route();
    };
  }
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

async function photoView(deck, mode = 'words') {
  const stoneMode = mode === 'stone';
  const { apiKey, model } = await settings.get();
  const existing = await db.listCards(deck.id);
  const photos = []; // { bitmap, rotate, crop }
  let stream = null;

  render(`
    <nav class="crumbs"><a href="#/deck/${deck.id}">← ${esc(deck.name)}</a></nav>
    <section class="panel" id="drop">
      ${
        stoneMode
          ? `<h2>📘 Stone → oefeningen</h2>
      <p class="muted">Maak een foto van een Stone (het schema met zinsdelen in vakjes). Claude maakt er oefenzinnen van met steeds andere namen, datums en woorden.
      Je schrijft je antwoord op papier en kijkt daarna zelf na.</p>
      ${apiKey ? '' : '<p class="panel error">Hiervoor is Claude nodig. Vul eerst een API-sleutel in bij <a href="#/settings">⚙ Instellingen</a>.</p>'}`
          : `<h2>Foto → kaartjes</h2>
      <p class="muted">Maak een scherpe, rechte foto van de woordjes in je boek. Meer pagina's? Kies meerdere foto's.</p>`
      }
      <div class="row">
        <label class="button big primary">🖼 Foto kiezen<input id="file" type="file" accept="image/*,.heic,.heif" multiple hidden></label>
        <button id="cam" class="big">📷 Camera</button>
      </div>
      <details class="iphone">
        <summary>📱 Foto gemaakt met je iPhone?</summary>
        <ol>
          <li>Mail de foto naar jezelf.</li>
          <li>Open de mail op de Chromebook en <b>download</b> de foto.</li>
          <li>Tik hier op <b>Foto kiezen</b> → map <b>Downloads</b>.</li>
        </ol>
      </details>
      <div id="camBox" hidden>
        <video id="video" autoplay playsinline></video>
        <div class="row"><button id="snap" class="primary big">Foto maken</button><button id="camStop">Klaar</button></div>
      </div>
      <div id="preview" hidden>
        <div id="thumbs" class="thumbs"></div>
        <div class="row">
          <label ${stoneMode ? 'hidden' : ''}>Herkennen met
            <select id="method">
              <option value="claude" ${apiKey ? 'selected' : 'disabled'}>${modelName(model)}${apiKey ? '' : ' – stel eerst een API-sleutel in'}</option>
              <option value="ocr" ${apiKey ? '' : 'selected'}>Gratis tekstherkenning (OCR)</option>
            </select>
          </label>
          <button id="run" class="primary big" ${stoneMode && !apiKey ? 'disabled' : ''}>${stoneMode ? 'Maak oefeningen' : 'Maak kaartjes'}</button>
        </div>
        <div id="progress" class="muted"></div>
      </div>
    </section>
    <div id="review"></div>`);

  const progress = document.getElementById('progress');
  const drawThumbs = () => {
    const box = document.getElementById('thumbs');
    box.innerHTML = '';
    photos.forEach((ph, i) => {
      const tile = document.createElement('div');
      tile.className = 'thumb';
      tile.appendChild(toCanvas(ph.bitmap, 900, { rotate: ph.rotate, crop: ph.crop }));
      const bar = document.createElement('div');
      bar.className = 'row';
      bar.innerHTML = `<button data-act="c" title="Alleen de woordjes selecteren">✂ Uitsnijden</button><button data-act="l" title="Draai links">⟲</button><button data-act="r" title="Draai rechts">⟳</button><button data-act="x" class="danger" title="Weghalen">✕</button>`;
      bar.onclick = async (e) => {
        const act = e.target.dataset.act;
        if (act === 'c') ph.crop = await cropDialog(ph);
        if (act === 'l' || act === 'r') ph.crop = null;
        if (act === 'l') ph.rotate = (ph.rotate + 270) % 360;
        if (act === 'r') ph.rotate = (ph.rotate + 90) % 360;
        if (act === 'x') photos.splice(i, 1);
        if (act) drawThumbs();
      };
      tile.appendChild(bar);
      box.appendChild(tile);
    });
    document.getElementById('preview').hidden = !photos.length;
    const label = stoneMode ? 'Maak oefeningen' : 'Maak kaartjes';
    document.getElementById('run').textContent = photos.length > 1 ? `${label} (${photos.length} foto's)` : label;
  };
  const addFiles = async (files) => {
    for (const file of files) {
      if (!isImageFile(file)) continue;
      try {
        progress.textContent = isHeic(file) ? 'iPhone-foto omzetten…' : '';
        photos.push({ bitmap: await loadImage(file), rotate: 0, crop: null });
      } catch (err) {
        console.error(err);
        toast(`Kan "${file.name}" niet openen`, 'bad');
      }
    }
    progress.textContent = '';
    drawThumbs();
  };
  const stopCam = () => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    document.getElementById('camBox').hidden = true;
  };
  const onPaste = (e) => addFiles([...(e.clipboardData?.files || [])]);
  document.addEventListener('paste', onPaste);
  cleanup = () => {
    stopCam();
    document.removeEventListener('paste', onPaste);
  };

  const drop = document.getElementById('drop');
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add('dragging');
  };
  drop.ondragleave = () => drop.classList.remove('dragging');
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    addFiles([...e.dataTransfer.files]);
  };
  document.getElementById('file').onchange = async (e) => {
    await addFiles([...e.target.files]);
    e.target.value = '';
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
    photos.push({ bitmap: await createImageBitmap(document.getElementById('video')), rotate: 0, crop: null });
    drawThumbs();
    toast('Foto toegevoegd. Nog een pagina? Maak nog een foto.', 'ok');
  };
  document.getElementById('run').onclick = async (e) => {
    const btn = e.target;
    const method = document.getElementById('method').value;
    btn.disabled = true;
    document.getElementById('review').innerHTML = '';
    if (stoneMode) {
      try {
        progress.textContent = `${modelName(model)} maakt oefeningen… (duurt ongeveer 30–90 seconden)`;
        const { claudeStone } = await import('./claude.js');
        const jpegs = photos.map(({ bitmap, rotate, crop }) => canvasToBase64Jpeg(toCanvas(bitmap, 1800, { rotate, crop })));
        const stone = await claudeStone(jpegs, apiKey, { model });
        progress.textContent = stone.exercises.length ? `${stone.exercises.length} oefeningen gemaakt.` : 'Geen Stone gevonden op de foto.';
        if (stone.exercises.length) document.getElementById('review').appendChild(stoneReview(deck, stone));
      } catch (err) {
        console.error(err);
        progress.textContent = '';
        toast(friendlyError(err), 'bad');
      } finally {
        btn.disabled = false;
      }
      return;
    }
    const rows = [];
    try {
      for (let i = 0; i < photos.length; i++) {
        const { bitmap, rotate, crop } = photos[i];
        const which = photos.length > 1 ? `Foto ${i + 1} van ${photos.length}: ` : '';
        if (method === 'claude') {
          progress.textContent = `${which}Claude leest de foto… (duurt ongeveer 10–30 seconden)`;
          const { claudePairs } = await import('./claude.js');
          const jpeg = canvasToBase64Jpeg(toCanvas(bitmap, 1800, { rotate, crop }));
          rows.push(...(await claudePairs(jpeg, apiKey, { frontLang: deck.frontLang, backLang: deck.backLang, model })));
        } else {
          progress.textContent = `${which}Tekstherkenning laden… (de eerste keer kan dit even duren)`;
          const { ocrPairs } = await import('./ocr.js');
          const res = await ocrPairs(toCanvas(bitmap, 2400, { rotate, crop, grayscale: true }), (m) => {
            if (m.status === 'Stand van de foto bepalen') progress.textContent = `${which}Stand van de foto bepalen…`;
            else if (m.status === 'recognizing text') progress.textContent = `${which}Tekst herkennen… ${Math.round(m.progress * 100)}%`;
          });
          rows.push(...res.rows);
        }
      }
      const tip = method === 'ocr' ? ' Veel fouten? Snij alleen de woordjes uit (✂) of gebruik Claude AI.' : '';
      progress.textContent = rows.length ? `${rows.length} regels gevonden.${tip}` : `Geen woordjes gevonden. Probeer een scherpere of rechtere foto.${tip}`;
      if (rows.length) document.getElementById('review').appendChild(reviewTable(deck, rows, existing));
    } catch (err) {
      console.error(err);
      progress.textContent = rows.length ? `${rows.length} regels gevonden; daarna ging er iets mis.` : '';
      if (rows.length) document.getElementById('review').appendChild(reviewTable(deck, rows, existing));
      toast(friendlyError(err), 'bad');
    } finally {
      btn.disabled = false;
    }
  };
}

// Controlescherm voor door Claude gemaakte Stone-oefeningen.
function stoneReview(deck, stone) {
  const box = document.createElement('section');
  box.className = 'panel';
  const count = () => stone.exercises.filter((e) => e.ok).length;
  box.innerHTML = `
    <h3>${esc(stone.title)}</h3>
    <p class="muted">Vink uit wat je niet wilt oefenen. Bij elke herhaling komt een andere variant.</p>
    ${stone.exercises
      .map(
        (e, i) => `
      <div class="stone-ex" data-i="${i}">
        <label class="inline"><input type="checkbox" class="ok" checked> <span class="badge">📘 ${esc(STONE_TYPES[e.type])}</span> <small class="muted">${esc(e.pattern)}</small></label>
        <ul>${e.variants.map((v) => `<li>${esc(v.prompt)} <span class="muted">→</span> <b>${esc(v.answer)}</b></li>`).join('')}</ul>
      </div>`
      )
      .join('')}
    <div class="row end"><button type="button" class="primary big save">${count()} oefeningen opslaan</button></div>`;
  box.addEventListener('change', (e) => {
    if (!e.target.classList.contains('ok')) return;
    const div = e.target.closest('.stone-ex');
    stone.exercises[div.dataset.i].ok = e.target.checked;
    div.classList.toggle('off', !e.target.checked);
    const btn = box.querySelector('.save');
    btn.textContent = `${count()} oefeningen opslaan`;
    btn.disabled = !count();
  });
  box.querySelector('.save').onclick = async () => {
    const keep = stone.exercises.filter((e) => e.ok);
    await db.putCards(keep.map((e) => db.makeStoneCard(deck.id, stone.title, e)));
    toast(`${keep.length} Stone-oefeningen toegevoegd`, 'ok');
    location.hash = `#/deck/${deck.id}`;
  };
  return box;
}

// Laat de gebruiker een rechthoek trekken om de woordjes. Geeft de uitsnede
// (fracties 0–1) terug, of null voor de hele foto.
function cropDialog(photo) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'crop-overlay';
    overlay.innerHTML = `
      <div class="crop-box">
        <p><b>Trek met je vinger of muis een vak om de woordjes.</b></p>
        <div class="crop-stage"><div class="crop-rect" hidden></div></div>
        <div class="row center">
          <button class="whole">Hele foto</button>
          <button class="cancel">Annuleren</button>
          <button class="primary done" disabled>Klaar ✓</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const stage = overlay.querySelector('.crop-stage');
    const rectEl = overlay.querySelector('.crop-rect');
    const canvas = toCanvas(photo.bitmap, 1400, { rotate: photo.rotate });
    stage.prepend(canvas);
    let start = null;
    let rect = photo.crop ? { ...photo.crop } : null;
    const show = () => {
      if (!rect) return;
      Object.assign(rectEl.style, {
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.w * 100}%`,
        height: `${rect.h * 100}%`,
      });
      rectEl.hidden = false;
      overlay.querySelector('.done').disabled = rect.w < 0.03 || rect.h < 0.03;
    };
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      };
    };
    stage.onpointerdown = (e) => {
      e.preventDefault();
      stage.setPointerCapture(e.pointerId);
      start = pos(e);
    };
    stage.onpointermove = (e) => {
      if (!start) return;
      const p = pos(e);
      rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      show();
    };
    stage.onpointerup = () => (start = null);
    show();
    const close = (value) => {
      overlay.remove();
      resolve(value);
    };
    overlay.querySelector('.whole').onclick = () => close(null);
    overlay.querySelector('.cancel').onclick = () => close(photo.crop);
    overlay.querySelector('.done').onclick = () => close(rect);
  });
}

// Nieuwe varianten voor Stone-oefeningen laten maken door Claude en opslaan.
// Geeft het aantal toegevoegde zinnen terug (0 zonder sleutel of internet).
async function topUpStones(stoneCards) {
  const { apiKey, model } = await settings.get();
  if (!apiKey) throw new Error('Vul eerst een Claude API-sleutel in bij Instellingen.');
  if (!navigator.onLine) throw new Error('Je bent offline. Nieuwe zinnen maken kan alleen met internet.');
  const { claudeMoreVariants } = await import('./claude.js');
  let added = 0;
  // In porties, zodat één verzoek niet te groot wordt.
  for (let i = 0; i < stoneCards.length; i += 12) {
    const part = stoneCards.slice(i, i + 12);
    const fresh = await claudeMoreVariants(part, apiKey, { model });
    for (const card of part) added += addVariants(card, fresh[card.id] || []);
    await db.putCards(part);
  }
  return added;
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
            <span><b>Omdraaien</b><br><small>Schrijf het antwoord op, draai om en beoordeel jezelf.</small></span></label>
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
  let variant = 0;
  const isStone = () => item && item.card.kind === 'stone';
  // Stone-oefeningen schrijf je op papier: altijd omdraaien, ook in de intyp-sessie.
  const curMode = () => (isStone() ? 'flip' : mode);

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
    if (isStone()) return nextStone();
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

  // Stone-oefening: opdracht tonen, antwoord op papier schrijven.
  function nextStone() {
    variant = nextVariant(item.card);
    const v = item.card.variants[variant];
    const english = item.card.type !== 'translate';
    const isNew = item.card.fwd.state === 'new';
    const promptHtml = esc(v.prompt).replace(/_{2,}/g, '<span class="gap">&nbsp;?&nbsp;</span>');
    $s.innerHTML = `
      <div class="card-label muted">📘 ${esc(item.card.stone || 'Stone')} · <b>${esc(STONE_TYPES[item.card.type])}</b>${isNew ? ' · <span class="c-new">nieuw</span>' : ''}</div>
      <div class="q stone-q">${promptHtml} ${english ? speakBtn(v.prompt.replace(/_{2,}/g, '…'), 'en') : ''}</div>
      <p class="paper">✍️ Schrijf je antwoord op papier.</p>
      <button id="flip" class="primary big">Toon antwoord <kbd>spatie</kbd></button>
      <div id="answer"></div>`;
    document.getElementById('flip').onclick = () => reveal(null);
  }

  function stoneAnswerHtml() {
    const c = item.card;
    const v = c.variants[variant];
    const main =
      c.type === 'gap'
        ? esc(v.prompt.replace(/\s*\([^)]*\)\s*$/, '')).replace(/_{2,}/g, `<b class="filled">${esc(v.answer)}</b>`)
        : esc(v.answer);
    const spoken = c.type === 'gap' ? v.prompt.replace(/\s*\([^)]*\)\s*$/, '').replace(/_{2,}/g, v.answer) : v.answer;
    return `
      <div class="a stone-a">${main} ${speakBtn(spoken, 'en')}</div>
      ${c.type === 'answer' ? '<p class="muted center">Voorbeeld. Jouw antwoord mag over jezelf gaan: klopt de zinsbouw?</p>' : ''}
      ${v.alternatives.length ? `<p class="center">Ook goed: ${v.alternatives.map((a) => `<b>${esc(a)}</b>`).join(' · ')}</p>` : ''}
      <p class="muted center small">Zinsbouw: ${esc(c.pattern)}</p>`;
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
      ${isStone() ? stoneAnswerHtml() : `<div class="a">${esc(answerText())} ${speakBtn(answerText(), aLang)}</div>`}
      ${typed !== null ? '<p class="muted center">Enter = voorgestelde knop. Klopt het oordeel niet? Kies zelf.</p>' : '<p class="muted center">Hoe goed wist je het?</p>'}
      <div class="rates">
        ${btn(AGAIN, 'Opnieuw', 'again')}${btn(HARD, 'Moeilijk', 'hard')}${btn(GOOD, 'Goed', 'good')}${btn(EASY, 'Makkelijk', 'easy')}
      </div>`;
    if (speakOn && aLang !== 'nl' && typed === null && !isStone()) speak(answerText(), aLang);
    $s.querySelector('.rates').onclick = (e) => {
      const b = e.target.closest('.rate');
      if (b) rate(Number(b.dataset.r));
    };
    if (typed !== null) $s.querySelector('.rate.suggested').focus();
  }

  async function rate(r) {
    if (phase !== 'answer') return;
    phase = 'saving';
    if (isStone()) {
      item.card.lastVariant = variant;
      // Laatste variant gehad: op de achtergrond nieuwe zinnen laten maken.
      if (!cram && needsMoreVariants(item.card, variant)) {
        const card = item.card;
        topUpStones([card]).catch((err) => console.warn('Nieuwe Stone-zinnen lukten niet:', err.message));
      }
    }
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
    if (phase === 'question' && curMode() === 'flip' && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      reveal(null);
    } else if (phase === 'answer' && !typing && ['1', '2', '3', '4'].includes(e.key)) {
      rate(Number(e.key));
    } else if (phase === 'answer' && e.key === 'Enter' && curMode() === 'type') {
      e.preventDefault();
      rate(suggested);
    } else if (phase === 'answer' && e.key === ' ' && curMode() === 'flip') {
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
    text: 'Open je hoofdstuk. Tik op <b>Foto → kaartjes</b>.<br>Foto <b>recht</b> en <b>scherp</b>.<br>Tip: met <b>✂ Uitsnijden</b> kies je alleen de woordjes.',
    demo: '<span class="demo-btn">📷 Foto → kaartjes</span>',
  },
  {
    emoji: '📱',
    title: 'Foto met je iPhone?',
    text: 'Mail hem naar jezelf.<br>Download hem op de Chromebook.<br>Tik op <b>Foto kiezen</b>.',
  },
  {
    emoji: '📘',
    title: 'Stones',
    text: 'Foto van een Stone? Tik op <b>Stone → oefeningen</b>.<br>De app verzint zinnen.<br>Jij schrijft het antwoord <b>op papier</b>.',
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
    text: 'Kies: <b>Omdraaien</b> (opschrijven) of <b>Intypen</b>.',
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
        <label>Claude-model
          <select name="model">
            ${CLAUDE_MODELS.map((m) => `<option value="${m.id}" ${m.id === s.model ? 'selected' : ''}>${m.name} – ${m.note}</option>`).join('')}
          </select>
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
    await db.setMeta('model', f.model.value);
    toast('Instellingen opgeslagen', 'ok');
  };
}

// ---------- Start ----------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
route();
