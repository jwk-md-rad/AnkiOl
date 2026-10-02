import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, schedule, AGAIN, HARD, GOOD, EASY, MINUTE, previewLabels } from '../js/srs.js';
import { checkAnswer, normalize } from '../js/check.js';
import { pairsFromText, pairsFromWords, plausible } from '../js/parse.js';
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

test('OCR-woorden: kolommen, uitspraak, zijvak, kopjes en schuine foto', () => {
  // Woorden als [tekst, x0, y, breedte, hoogte, betrouwbaarheid]; pagina 2° scheef.
  const tan = Math.tan((2 * Math.PI) / 180);
  const w = (text, x0, y, width, h = 20, confidence = 90) => {
    const dy = x0 * tan;
    return { text, confidence, bbox: { x0, x1: x0 + width, y0: y + dy, y1: y + dy + h } };
  };
  const words = [
    w('Unit', 400, 0, 80, 34), w('3', 490, 0, 20, 34), w('Words', 900, 0, 90, 34),
    w('Tip!', 20, 100, 50), w('Leer', 80, 100, 50),
    w('brother', 400, 100, 90), w('[brʌðə]', 650, 100, 80, 20, 50), w('broer', 900, 100, 60),
    w('Say', 20, 140, 40), w('this', 70, 140, 40),
    w('to', 400, 140, 25), w('be', 430, 140, 25), w('married', 460, 140, 80), w('[ˈmærid]', 650, 140, 80, 20, 40), w('getrouwd', 900, 140, 90), w('zijn', 995, 140, 40),
    w('cousin', 400, 180, 70), w('[kʌzn]', 650, 180, 70), w('neef,', 900, 180, 50), w('nicht', 955, 180, 50),
    w('~|', 400, 220, 20, 20, 20), w('aunt', 400, 260, 50), w('[ɑːnt]', 650, 260, 60), w('tante', 900, 260, 60),
  ];
  const angle = Math.atan(tan);
  const rows = pairsFromWords(words, angle);
  const ok = rows.filter((r) => r.ok).map((r) => `${r.front} = ${r.back}`);
  assert.deepEqual(ok, ['brother = broer', 'to be married = getrouwd zijn', 'cousin = neef, nicht', 'aunt = tante']);
  assert.ok(rows.some((r) => r.front === 'Unit 3' && r.back === 'Words' && !r.ok), 'kopje niet aangevinkt');
  assert.ok(!rows.some((r) => /Tip|Say/.test(r.front + r.back)), 'zijvak genegeerd');
});

test('plausible herkent OCR-rommel', () => {
  assert.equal(plausible('house'), true);
  assert.equal(plausible('„B'), false);
  assert.equal(plausible('oY) ga. 0'), false);
  assert.equal(plausible('§'), false);
  assert.equal(plausible('stiefvader', 30), false);
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
