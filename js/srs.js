// Spaced repetition, gebaseerd op het SM-2 algoritme zoals Anki het gebruikt:
// nieuwe kaarten doorlopen korte leerstappen (minuten), daarna groeien de
// intervallen (dagen) met de "ease"-factor van de kaart.

export const MINUTE = 60 * 1000;
export const DAY = 24 * 60 * MINUTE;
export const DAY_CUTOFF_HOUR = 4; // een nieuwe "leerdag" begint om 04:00

export const DEFAULTS = {
  learningSteps: [1, 10], // minuten
  relearnSteps: [10], // minuten
  graduatingInterval: 1, // dagen
  easyInterval: 4, // dagen
  startEase: 2.5,
  minEase: 1.3,
  easyBonus: 1.3,
  hardFactor: 1.2,
  lapseFactor: 0.5,
  maxInterval: 3650,
};

export const AGAIN = 1;
export const HARD = 2;
export const GOOD = 3;
export const EASY = 4;

export function newState() {
  return { state: 'new', step: 0, due: 0, interval: 0, ease: DEFAULTS.startEase, reps: 0, lapses: 0 };
}

// Begin van de leerdag waar `now` in valt.
export function dayStart(now) {
  const d = new Date(now);
  d.setHours(DAY_CUTOFF_HOUR, 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}

function dueInDays(now, days) {
  const d = new Date(dayStart(now));
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function clampInterval(days, opts) {
  return Math.min(opts.maxInterval, Math.max(1, Math.round(days)));
}

function stepDelay(steps, step, rating) {
  const cur = steps[Math.min(step, steps.length - 1)];
  if (rating === HARD) {
    const next = steps[step + 1];
    return (next ? (cur + next) / 2 : cur * 1.5) * MINUTE;
  }
  return cur * MINUTE;
}

export function schedule(prev, rating, now = Date.now(), opts = DEFAULTS) {
  const s = { ...prev, reps: prev.reps + 1, lastReview: now };

  if (s.state === 'new' || s.state === 'learning') {
    const steps = opts.learningSteps;
    if (rating === EASY) return graduate(s, opts.easyInterval, now, opts);
    if (rating === AGAIN) s.step = 0;
    if (rating === GOOD) {
      s.step += 1;
      if (s.step >= steps.length) return graduate(s, opts.graduatingInterval, now, opts);
    }
    s.state = 'learning';
    s.due = now + stepDelay(steps, s.step, rating);
    return s;
  }

  if (s.state === 'relearning') {
    const steps = opts.relearnSteps;
    if (rating === EASY) return graduate(s, s.interval + 1, now, opts);
    if (rating === AGAIN) s.step = 0;
    if (rating === GOOD) {
      s.step += 1;
      if (s.step >= steps.length) return graduate(s, s.interval, now, opts);
    }
    s.due = now + stepDelay(steps, s.step, rating);
    return s;
  }

  // review
  if (rating === AGAIN) {
    s.lapses += 1;
    s.ease = Math.max(opts.minEase, s.ease - 0.2);
    s.interval = clampInterval(s.interval * opts.lapseFactor, opts);
    s.state = 'relearning';
    s.step = 0;
    s.due = now + opts.relearnSteps[0] * MINUTE;
    return s;
  }
  let ivl;
  if (rating === HARD) {
    ivl = s.interval * opts.hardFactor;
    s.ease = Math.max(opts.minEase, s.ease - 0.15);
  } else if (rating === GOOD) {
    ivl = s.interval * s.ease;
  } else {
    ivl = s.interval * s.ease * opts.easyBonus;
    s.ease += 0.15;
  }
  s.interval = clampInterval(Math.max(ivl, s.interval + 1), opts);
  s.due = dueInDays(now, s.interval);
  return s;
}

function graduate(s, days, now, opts) {
  s.state = 'review';
  s.step = 0;
  s.interval = clampInterval(days, opts);
  s.due = dueInDays(now, s.interval);
  return s;
}

// Tekst voor op de beoordelingsknoppen, bv. "10 min" of "3 d".
export function previewLabels(state, now = Date.now(), opts = DEFAULTS) {
  const out = {};
  for (const r of [AGAIN, HARD, GOOD, EASY]) {
    const next = schedule(state, r, now, opts);
    out[r] = next.state === 'review' ? formatDays(next.interval) : formatMs(next.due - now);
  }
  return out;
}

export function formatMs(ms) {
  const min = Math.max(1, Math.round(ms / MINUTE));
  if (min < 60) return `${min} min`;
  return `${Math.round(min / 60)} u`;
}

export function formatDays(d) {
  if (d < 31) return `${d} d`;
  if (d < 365) return `${Math.round(d / 30.4)} mnd`;
  return `${(d / 365).toFixed(1).replace('.0', '')} j`;
}

export function isDue(state, now = Date.now()) {
  return state.state !== 'new' && state.due <= now;
}
