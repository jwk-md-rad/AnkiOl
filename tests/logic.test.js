import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, schedule, AGAIN, HARD, GOOD, EASY, MINUTE, previewLabels } from '../js/srs.js';
import { checkAnswer, normalize } from '../js/check.js';
import { pairsFromText, pairsFromLines, plausible } from '../js/parse.js';
import { Session, countDue, nextVariant, dirsFor } from '../js/session.js';

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
