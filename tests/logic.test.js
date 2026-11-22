import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, schedule, AGAIN, HARD, GOOD, EASY, MINUTE, DAY, DEFAULTS, previewLabels, capState } from '../js/srs.js';
import { checkAnswer, normalize } from '../js/check.js';
import { pairsFromText, findInSentence } from '../js/parse.js';
import { Session, countDue, nextVariant, dirsFor, addVariants, needsMoreVariants, sectionOf, sectionList } from '../js/session.js';

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
  // Het algoritme zelf, zonder het maximum van 6 dagen.
  const opts = { ...DEFAULTS, maxInterval: 3650 };
  let s = { ...newState(), state: 'review', interval: 10, ease: 2.5, due: NOW };
  const good = schedule(s, GOOD, NOW, opts);
  assert.equal(good.interval, 25);
  const hard = schedule(s, HARD, NOW, opts);
  assert.equal(hard.interval, 12);
  const easy = schedule(s, EASY, NOW, opts);
  assert.ok(easy.interval > good.interval);
  const lapse = schedule(s, AGAIN, NOW, opts);
  assert.equal(lapse.state, 'relearning');
  assert.equal(lapse.lapses, 1);
  assert.equal(lapse.interval, 5);
  assert.ok(Math.abs(lapse.ease - 2.3) < 1e-9);
  const back = schedule(lapse, GOOD, NOW + 10 * MINUTE, opts);
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
  assert.equal(checkAnswer('I am fine', "I'm fine (thanks)"), 'correct'); // samentrekking telt als hetzelfde
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

test('Engelse samentrekkingen tellen als hetzelfde antwoord', () => {
  const same = [
    ["It is my birthday", "It's my birthday"],
    ["I am Dutch", "I'm Dutch"],
    ["I do not like it", "I don't like it"],
    ["She cannot swim", "She can't swim"],
    ["She can not swim", "She can't swim"],
    ["They will not come", "They won't come"],
    ["it isn't", "it's not"],
    ["you aren't", "you're not"],
    ["We are from Utrecht", "We're from Utrecht"],
    ["I have got a sister", "I've got a sister"],
    ["He has got a dog", "He's got a dog"],
    ["I would like a pizza", "I'd like a pizza"],
    ["What is your name?", "What's your name?"],
    ["Let us go", "Let's go"],
    ["I will help you", "I'll help you"],
    ["It's my bike", "It is my bike"],
  ];
  for (const [given, expected] of same) assert.equal(checkAnswer(given, expected), 'correct', `${given} = ${expected}`);
  // Bezit-'s blijft bezit, en "its" is iets anders dan "it's".
  assert.equal(normalize("Tom's bike"), "tom's bike");
  assert.notEqual(checkAnswer('its', "it's"), 'correct');
});

test('apostrof vergeten = bijna goed met tweede kans', async () => {
  const { oneLetterOff } = await import('../js/check.js');
  assert.equal(checkAnswer('I dont like it', "I don't like it"), 'almost');
  assert.equal(checkAnswer('Im Dutch', "I'm Dutch"), 'almost');
  assert.equal(oneLetterOff('cant', "can't"), true);
  assert.equal(oneLetterOff("can't", "can't"), false);
  assert.equal(oneLetterOff('cannot', "can't"), false); // gewoon goed
});

test('woord terugvinden in de voorbeeldzin', () => {
  const s = 'We have to be very lucky to have such nice neighbours.';
  assert.deepEqual(findInSentence(s, 'be lucky').map(([a, b]) => s.slice(a, b)), ['be', 'lucky']);
  assert.deepEqual(findInSentence('He is focusing.', 'focus').map(([a, b]) => 'He is focusing.'.slice(a, b)), ['focusing']);
  assert.deepEqual(findInSentence('Nothing here.', 'brain'), []);
});

test('synchroniseren: overhoor-instellingen, laatste wijziging wint', async () => {
  const { mergeData } = await import('../js/merge.js');
  const deck = { id: 'd1', name: 'H1', updated: 1 };
  const chromebook = {
    decks: [deck],
    cards: [],
    prefs: {
      'study:d1': { value: { mode: 'type', dir: 'rev' }, updated: 200 },
      speak: { value: true, updated: 100 },
      'new:d1': { value: { day: 'Thu Oct 22 2026', count: 5 }, updated: 150 },
      'study:weg': { value: { mode: 'flip' }, updated: 300 },
    },
  };
  const iphone = {
    decks: [deck],
    cards: [],
    prefs: {
      'study:d1': { value: { mode: 'flip', dir: 'fwd' }, updated: 100 },
      speak: { value: false, updated: 250 },
      'new:d1': { value: { day: 'Thu Oct 22 2026', count: 8 }, updated: 120 },
    },
  };
  const { prefs } = mergeData(chromebook, iphone);
  assert.deepEqual(prefs['study:d1'].value, { mode: 'type', dir: 'rev' });
  assert.equal(prefs.speak.value, false);
  assert.deepEqual(prefs['new:d1'].value, { day: 'Thu Oct 22 2026', count: 8 });
  assert.equal(prefs['study:weg'], undefined, 'instelling van een verwijderd hoofdstuk valt weg');
  // Oude gegevens zonder instellingen blijven werken.
  assert.deepEqual(mergeData({ decks: [deck], cards: [] }, { decks: [deck], cards: [] }).prefs, {});
});

test('herhalingen nooit verder dan 6 dagen vooruit', () => {
  let s = schedule(newState(), EASY, NOW);
  for (let i = 0; i < 6; i++) s = schedule(s, EASY, s.due);
  assert.equal(s.interval, 6);
  assert.ok(s.due - s.lastReview <= 6 * DAY + DAY, 'hooguit 6 dagen (tot de volgende leerdag)');
  assert.equal(previewLabels(s, s.due)[4], '6 d');
  // Eerder (met een oudere versie) 25 dagen vooruit gepland: terug naar 6 dagen.
  const old = { ...newState(), state: 'review', interval: 25, ease: 2.5, lastReview: NOW, due: NOW + 25 * DAY };
  assert.equal(capState(old, NOW), true);
  assert.equal(old.interval, 6);
  assert.ok(old.due <= NOW + 6 * DAY);
  assert.equal(capState(old, NOW), false, 'tweede keer niets meer te doen');
  assert.equal(capState(newState(), NOW), false);
});

test('delen van het boek: volgorde en Stones', () => {
  // Volgorde voor de keuze bij overhoren: A, B, … dan Stones, dan "zonder deel".
  const cards = [{ section: 'D Flavours' }, {}, { kind: 'stone', stone: 'Stone 3' }, { section: 'A Watching' }, { section: 'B Groceries' }];
  assert.deepEqual(sectionList(cards), ['A Watching', 'B Groceries', 'D Flavours', '📘 Stone 3', '']);
  assert.equal(sectionOf({ kind: 'stone', stone: 'Stone 3', section: 'x' }), '📘 Stone 3');
});

test('Claude-antwoord per deel → kaartjes met hun deel', async () => {
  const { cardsFromSections } = await import('../js/claude.js');
  const cards = cardsFromSections({
    sections: [
      { section: 'B In the kitchen', cards: [{ front: 'slice', back: 'plak, snee', example: '' }] },
      { section: 'D Flavours', cards: [{ front: ' savoury ', back: 'hartig', example: '' }, { front: '', back: 'leeg', example: '' }] },
    ],
  });
  assert.deepEqual(
    cards.map((c) => [c.front, c.back, c.section]),
    [['slice', 'plak, snee', 'B In the kitchen'], ['savoury', 'hartig', 'D Flavours']]
  );
  assert.deepEqual(cardsFromSections({}), []);
});
