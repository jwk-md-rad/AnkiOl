// Aanmoedigingen tijdens het overhoren: na een willekeurig aantal kaartjes een
// kort geanimeerd "gifje" met een bemoedigende tekst. Zelfgemaakte animaties
// (geen plaatjes van internet): werkt offline en is altijd geschikt.

export const MESSAGES = [
  'Lekker bezig!',
  'Ga zo door!',
  'Goed bezig!',
  'Je bent on fire!',
  'Keep going!',
  'Top gedaan!',
  'Nice!',
  'Niet te stoppen!',
  'Woordjes-kampioen!',
  'Bijna een pro!',
];

// Soorten animatie: welke emoji, hoe hij beweegt.
export const SHOWS = [
  { emoji: '🎉', move: 'pop', confetti: true },
  { emoji: '🔥', move: 'pulse' },
  { emoji: '💪', move: 'flex' },
  { emoji: '🚀', move: 'rocket' },
  { emoji: '⭐', move: 'spin', confetti: true },
  { emoji: '😎', move: 'pop' },
  { emoji: '🏆', move: 'bounce', confetti: true },
  { emoji: '👏', move: 'clap' },
  { emoji: '🦄', move: 'bounce' },
  { emoji: '⚡', move: 'pulse' },
];

// Na hoeveel kaartjes de volgende aanmoediging? Willekeurig 6 t/m 14.
export function nextGap(random = Math.random) {
  return 6 + Math.floor(random() * 9);
}

// Kies een animatie en tekst (niet twee keer achter elkaar dezelfde).
export function pick(last = {}, random = Math.random) {
  const choose = (list, avoid) => {
    let i = Math.floor(random() * list.length);
    if (list.length > 1 && i === avoid) i = (i + 1) % list.length;
    return i;
  };
  const show = choose(SHOWS, last.show);
  const message = choose(MESSAGES, last.message);
  return { show, message };
}

const CONFETTI_COLORS = ['#ff4d6d', '#ffd166', '#06d6a0', '#118ab2', '#9b5de5', '#f15bb5'];

// Toon de aanmoediging; sluit vanzelf of bij een tik/toets. Geeft een promise
// die klaar is als hij weg is.
export function showCheer({ show, message }, answered) {
  const s = SHOWS[show];
  const extra = answered >= 10 ? `<div class="cheer-count">Al ${answered} kaartjes!</div>` : '';
  const el = document.createElement('div');
  el.className = 'cheer';
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <div class="cheer-card">
      <div class="cheer-emoji move-${s.move}">${s.emoji}</div>
      <div class="cheer-text">${MESSAGES[message]}</div>
      ${extra}
    </div>`;
  if (s.confetti) {
    for (let i = 0; i < 40; i++) {
      const c = document.createElement('i');
      c.className = 'confetti';
      c.style.left = `${Math.random() * 100}%`;
      c.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      c.style.animationDelay = `${Math.random() * 0.4}s`;
      c.style.animationDuration = `${1.4 + Math.random() * 1.2}s`;
      c.style.setProperty('--drift', `${Math.random() * 120 - 60}px`);
      el.appendChild(c);
    }
  }
  document.body.appendChild(el);
  return new Promise((resolve) => {
    let closed = false;
    const close = (e) => {
      if (closed) return;
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      closed = true;
      clearTimeout(timer);
      document.removeEventListener('keydown', close, true);
      el.classList.add('cheer-out');
      setTimeout(() => {
        el.remove();
        resolve();
      }, 250);
    };
    const timer = setTimeout(close, 2300);
    el.addEventListener('click', close);
    // Toetsen tijdens de animatie sluiten hem (en tellen niet als beoordeling).
    document.addEventListener('keydown', close, true);
  });
}
