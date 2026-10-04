import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, schedule, AGAIN, HARD, GOOD, EASY, MINUTE, previewLabels } from '../js/srs.js';
import { checkAnswer, normalize } from '../js/check.js';
import { pairsFromText, pairsFromLines, plausible } from '../js/parse.js';
import { Session, countDue, nextVariant, dirsFor, addVariants, needsMoreVariants } from '../js/session.js';

const NOW = new Date('2026-10-02T15:00:00').getTime();

test('nieuwe kaart doorloopt leerstappen en studeert af', () => {
  let s = schedule(newState(), GOOD, NOW);
  assert.equal(s.state, 'learning');
  assert.equal(s.due - NOW, 10 * MINUTE);
  s = schedule(s, GOOD, NOW + 10 * MINUTE);
  assert.equal(s.state, 'review');
  assert.equal(s.interval, 1);
  assert.equal(new Date(s.due).getHours(), 4);
});

test('opnieuw zet de kaart terug naar de eerste stap', () => {
  const s = schedule(newState(), AGAIN, NOW);
  assert.equal(s.state, 'learning');
  assert.equal(s.due - NOW, MINUTE);
});

test('makkelijk studeert direct af met 4 dagen', () => {
  const s = schedule(newState(), EASY, NOW);
  assert.equal(s.state, 'review');
  assert.equal(s.interval, 4);
});

test('intervallen groeien en een fout verlaagt ease', () => {
  let s = { ...newState(), state: 'review', interval: 10, ease: 2.5, due: NOW };
  const good = schedule(s, GOOD, NOW);
  assert.equal(good.interval, 25);
  const hard = schedule(s, HARD, NOW);
  assert.equal(hard.interval, 12);
  const easy = schedule(s, EASY, NOW);
  assert.ok(easy.interval > good.interval);
  const lapse = schedule(s, AGAIN, NOW);
  assert.equal(lapse.state, 'relearning');
  assert.equal(lapse.lapses, 1);
  assert.equal(lapse.interval, 5);
  assert.ok(Math.abs(lapse.ease - 2.3) < 1e-9);
  const back = schedule(lapse, GOOD, NOW + 10 * MINUTE);
  assert.equal(back.state, 'review');
  assert.equal(back.interval, 5);
});

test('previewLabels geeft tekst voor elke knop', () => {
  const l = previewLabels(newState(), NOW);
  assert.deepEqual(l, { 1: '1 min', 2: '6 min', 3: '10 min', 4: '4 d' });
});

test('antwoordcontrole is tolerant', () => {
  assert.equal(checkAnswer('Huis', 'het huis'), 'correct');
  assert.equal(checkAnswer('run', 'to run'), 'correct');
  assert.equal(checkAnswer('woning', 'huis, woning'), 'correct');
  assert.equal(checkAnswer('cafe', 'café'), 'correct');
  assert.equal(checkAnswer('beautifull', 'beautiful'), 'almost');
  assert.equal(checkAnswer('hond', 'kat'), 'wrong');
  assert.equal(checkAnswer('', 'kat'), 'wrong');
  assert.equal(checkAnswer('I am fine', "I'm fine (thanks)"), 'almost');
  assert.equal(checkAnswer('I am happy', "I'm fine"), 'wrong');
  assert.equal(checkAnswer("i'm fine", "I'm fine (thanks)"), 'correct');
  assert.equal(normalize('  The  Car! '), 'car');
});

test('tekst plakken wordt gesplitst in paren', () => {
  const rows = pairsFromText('house - huis\n1. to run = rennen\nwell-known\tbekend\nHoofdstuk 3\n\n');
  assert.deepEqual(
    rows.map((r) => [r.front, r.back, r.ok]),
    [
      ['house', 'huis', true],
      ['to run', 'rennen', true],
      ['well-known', 'bekend', true],
      ['Hoofdstuk 3', '', false],
    ]
  );
});

// Nagebootste OCR-uitvoer zoals Tesseract die geeft (elke regel met woorden,
// posities en basislijn), van een scheve, buigende leerboekpagina.
function fakeOcr(cells, { slope = (x, y) => -0.08 + y / 20000 } = {}) {
  const H = 30;
  return cells.map(([text, x, row, conf = 92]) => {
    const words = [];
    let cx = x;
    const y0 = 60 + row * 55;
    for (const t of text.split(' ')) {
      const w = t.length * 16;
      const m = slope(cx, y0);
      const yb = y0 + m * cx;
      words.push({ text: t, confidence: conf, bbox: { x0: cx, x1: cx + w, y0: yb - H, y1: yb }, baseline: { x0: cx, x1: cx + w, y0: yb, y1: yb + m * w, has_baseline: true } });
      cx += w + 12;
    }
    const f = words[0];
    const l = words[words.length - 1];
    return { words, baseline: { x0: f.baseline.x0, y0: f.baseline.y0, x1: l.baseline.x1, y1: l.baseline.y1 } };
  });
}

test('OCR-pagina: twee tabellen, schuin, vakjes, getallen, kopjes, doorlopende woordjes', () => {
  const cells = [
    ['B Looks', 60, 0], ['Uiterlijk', 360, 0],
    ['O bald', 60, 1], ['kaal', 360, 1],
    ['[J beard', 60, 2], ['[brɪəd]', 230, 2, 60], ['baard', 360, 2],
    ['WW scar', 60, 3], ['litteken', 360, 3],
    ['thirty', 60, 4], ['30', 360, 4],
    ['O great-', 60, 5], ['overgrootvader', 360, 5],
    ['grandfather', 60, 6],
    ['one thousand', 60, 7],
    ['and eleven', 60, 8], ['1011', 360, 8],
    ['O nephew', 60, 9], ['neef (kind van', 360, 9],
    ['zus/broer)', 360, 10],
    ['O shy', 800, 1], ['verlegen', 1100, 1],
    ['O smart', 800, 2], ['slim', 1100, 2],
    ['O sweet', 800, 3], ['lief', 1100, 3],
    ['O mean', 800, 4], ['gemeen', 1100, 4],
    ['~|', 800, 5, 20],
  ];
  const rows = pairsFromLines(fakeOcr(cells));
  const ok = rows.filter((r) => r.ok).map((r) => `${r.front} = ${r.back}`);
  assert.deepEqual(ok, [
    'bald = kaal',
    'beard = baard',
    'scar = litteken',
    'thirty = 30',
    'great-grandfather = overgrootvader',
    'one thousand and eleven = 1011',
    'nephew = neef (kind van zus/broer)',
    'shy = verlegen',
    'smart = slim',
    'sweet = lief',
    'mean = gemeen',
  ]);
  assert.ok(rows.some((r) => r.front === 'Looks' && r.back === 'Uiterlijk' && !r.ok), 'kopje niet aangevinkt');
});

test('plausible herkent OCR-rommel', () => {
  assert.equal(plausible('house'), true);
  assert.equal(plausible('„B'), false);
  assert.equal(plausible('oY) ga. 0'), false);
  assert.equal(plausible('§'), false);
  assert.equal(plausible('stiefvader', 30), false);
  assert.equal(plausible('1011'), true);
});

test('sessie: nieuwe kaarten max per dag, één richting per kaart', () => {
  const cards = Array.from({ length: 30 }, (_, i) => ({
    id: `c${i}`,
    created: i,
    front: `w${i}`,
    back: `v${i}`,
    fwd: newState(),
    rev: newState(),
  }));
  const s = new Session(cards, ['fwd', 'rev'], { newLimit: 20, now: NOW });
  assert.equal(s.newItems.length, 20);
  assert.equal(new Set(s.newItems.map((i) => i.card.id)).size, 20);

  // Alles goed beantwoorden tot de sessie klaar is.
  let t = NOW;
  let guard = 0;
  for (let it = s.next(t); it && guard < 200; it = s.next(t), guard++) {
    s.answer(it, GOOD, t);
    t += 30 * 1000;
  }
  assert.ok(guard < 200, 'sessie moet eindigen');
  assert.equal(s.stats.answered, 40); // elke kaart 2x (leerstap 1 + 10 min)
  assert.ok(cards.filter((c) => c.fwd.state === 'review' || c.rev.state === 'review').length === 20);
});

test('Stone-oefeningen: één richting en steeds een andere variant', () => {
  const stone = {
    id: 's1',
    kind: 'stone',
    created: 0,
    variants: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }],
    fwd: newState(),
    rev: newState(),
  };
  const word = { id: 'w1', created: 1, front: 'house', back: 'huis', fwd: newState(), rev: newState() };
  assert.deepEqual(dirsFor(stone, ['fwd', 'rev']), ['fwd']);
  assert.deepEqual(dirsFor(stone, ['rev']), ['fwd']);
  assert.deepEqual(countDue([stone, word], ['fwd', 'rev']), { fresh: 3, learn: 0, review: 0 });
  // Een sessie NL→EN neemt de Stone-oefening ook mee.
  const s = new Session([stone, word], ['rev'], { newLimit: 10, now: NOW });
  assert.deepEqual(s.newItems.map((i) => `${i.card.id}:${i.dir}`).sort(), ['s1:fwd', 'w1:rev']);
  const seen = [];
  for (let k = 0; k < 4; k++) {
    const v = nextVariant(stone);
    seen.push(v);
    stone.lastVariant = v;
  }
  assert.deepEqual(seen, [0, 1, 2, 0]);
});

test('Stone: nieuwe varianten toevoegen zonder dubbele, met maximum', () => {
  const v = (prompt) => ({ prompt, answer: prompt.toUpperCase(), alternatives: [] });
  const card = { kind: 'stone', variants: [v('a b'), v('c d')], lastVariant: 1 };
  assert.equal(needsMoreVariants(card, 0), false);
  assert.equal(needsMoreVariants(card, 1), true);
  assert.equal(addVariants(card, [v('A, b!'), v('e f'), v('g h'), v('e f')]), 2);
  assert.deepEqual(card.variants.map((x) => x.prompt), ['a b', 'c d', 'e f', 'g h']);
  // Na de laatste oude variant komen de nieuwe aan de beurt.
  assert.equal(nextVariant(card), 2);
  // Maximum: de oudste vallen weg en de teller schuift mee.
  addVariants(card, [v('i j'), v('k l')], 4);
  assert.deepEqual(card.variants.map((x) => x.prompt), ['e f', 'g h', 'i j', 'k l']);
  assert.equal(card.lastVariant, -1);
  assert.equal(nextVariant(card), 0);
});

test('synchroniseren: samenvoegen van twee apparaten', async () => {
  const { mergeData } = await import('../js/merge.js');
  const T = 1_000_000;
  const st = (lastReview, interval) => ({ ...newState(), state: 'review', lastReview, interval });
  const deck = { id: 'd1', name: 'H1', updated: T };
  // Chromebook: kaart a bewerkt (later), kaart b fwd later geoefend, kaart c verwijderd.
  const chromebook = {
    decks: [deck],
    cards: [
      { id: 'a', deckId: 'd1', front: 'house', back: 'huis!', updated: T + 50, fwd: st(T, 1), rev: newState() },
      { id: 'b', deckId: 'd1', front: 'cat', back: 'kat', updated: T + 10, fwd: st(T + 10, 3), rev: st(T, 1) },
    ],
    deleted: { c: T + 20 },
  };
  // iPhone: kaart a ouder, kaart b rev later geoefend, kaart c nog aanwezig, nieuwe kaart d,
  // en een Stone-kaart met extra varianten.
  const iphone = {
    decks: [deck],
    cards: [
      { id: 'a', deckId: 'd1', front: 'house', back: 'huis', updated: T + 5, fwd: st(T + 40, 6), rev: newState() },
      { id: 'b', deckId: 'd1', front: 'cat', back: 'kat', updated: T + 30, fwd: st(T, 1), rev: st(T + 30, 4) },
      { id: 'c', deckId: 'd1', front: 'dog', back: 'hond', updated: T + 1, fwd: newState(), rev: newState() },
      { id: 'd', deckId: 'd1', front: 'tree', back: 'boom', updated: T + 2, fwd: newState(), rev: newState() },
    ],
    deleted: {},
  };
  const m = mergeData(chromebook, iphone, T + 100);
  const card = (id) => m.cards.find((c) => c.id === id);
  assert.deepEqual(m.cards.map((c) => c.id).sort(), ['a', 'b', 'd']);
  assert.equal(card('a').back, 'huis!', 'laatste bewerking wint');
  assert.equal(card('a').fwd.interval, 6, 'laatste keer overhoren wint per richting');
  assert.equal(card('b').fwd.interval, 3);
  assert.equal(card('b').rev.interval, 4);
  assert.equal(m.deleted.c, T + 20);
  // Andersom samenvoegen geeft hetzelfde.
  const m2 = mergeData(iphone, chromebook, T + 100);
  assert.deepEqual(m2.cards.map((c) => [c.id, c.back, c.fwd.interval, c.rev.interval]).sort(), m.cards.map((c) => [c.id, c.back, c.fwd.interval, c.rev.interval]).sort());
  // Hoofdstuk verwijderd → kaartjes ook weg; opnieuw aangemaakt na verwijderen → blijft.
  const gone = mergeData({ ...chromebook, deleted: { d1: T + 60 } }, iphone, T + 100);
  assert.equal(gone.decks.length, 0);
  assert.equal(gone.cards.length, 0);
  // Stone: varianten van beide kanten blijven.
  const v = (p) => ({ prompt: p, answer: p, alternatives: [] });
  const s1 = { id: 's', deckId: 'd1', kind: 'stone', variants: [v('a'), v('b')], updated: T + 5, fwd: newState(), rev: newState() };
  const s2 = { ...s1, variants: [v('a'), v('c')], updated: T + 6 };
  const ms = mergeData({ decks: [deck], cards: [s1] }, { decks: [deck], cards: [s2] }, T + 100);
  assert.deepEqual(ms.cards[0].variants.map((x) => x.prompt), ['a', 'c', 'b']);
});

test('aanmoedigingen: willekeurig om de 6–14 kaartjes, niet twee keer dezelfde', async () => {
  const { nextGap, pick, SHOWS, MESSAGES } = await import('../js/cheer.js');
  assert.equal(nextGap(() => 0), 6);
  assert.equal(nextGap(() => 0.999), 14);
  let last = {};
  for (let k = 0; k < 50; k++) {
    const next = pick(last);
    assert.ok(next.show >= 0 && next.show < SHOWS.length);
    assert.ok(next.message >= 0 && next.message < MESSAGES.length);
    assert.notEqual(next.show, last.show);
    assert.notEqual(next.message, last.message);
    last = next;
  }
});

test('één letter fout geeft een tweede kans', async () => {
  const { oneLetterOff } = await import('../js/check.js');
  assert.equal(oneLetterOff('beautifl', 'beautiful'), true); // letter vergeten
  assert.equal(oneLetterOff('hius', 'huis'), true); // twee letters omgewisseld telt als één fout
  assert.equal(oneLetterOff('becuase', 'because'), true);
  assert.equal(oneLetterOff('hiuss', 'huis'), false); // omgewisseld én extra letter = twee fouten
  assert.equal(oneLetterOff('huiss', 'het huis'), true); // lidwoord telt niet mee
  assert.equal(oneLetterOff('woninh', 'huis, woning'), true); // ook bij een alternatief
  assert.equal(oneLetterOff('huis', 'huis'), false); // gewoon goed
  assert.equal(oneLetterOff('beautfl', 'beautiful'), false); // twee letters fout
  assert.equal(oneLetterOff('ja', 'je'), false); // te kort
  assert.equal(oneLetterOff('', 'huis'), false);
});
