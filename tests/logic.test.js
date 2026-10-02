import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, schedule, AGAIN, HARD, GOOD, EASY, MINUTE, previewLabels } from '../js/srs.js';
import { checkAnswer, normalize } from '../js/check.js';
import { pairsFromText, pairsFromOcrLines } from '../js/parse.js';
import { Session } from '../js/session.js';

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

test('OCR-kolommen worden herkend aan het gat tussen woorden', () => {
  const w = (text, x0, x1) => ({ text, bbox: { x0, x1, y0: 0, y1: 20 } });
  const rows = pairsFromOcrLines([
    { text: 'the weather het weer', words: [w('the', 0, 30), w('weather', 36, 110), w('het', 400, 430), w('weer', 436, 480)] },
    { text: 'Unit 3 Words', words: [w('Unit', 0, 40), w('3', 46, 56), w('Words', 62, 120)] },
  ]);
  assert.deepEqual(rows[0], { front: 'the weather', back: 'het weer', ok: true });
  assert.equal(rows[1].ok, false);
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
