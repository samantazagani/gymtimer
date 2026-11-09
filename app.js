'use strict';

/* =====================================================================
   GymTimer — Tabata / EMOM / AMRAP
   Tutto locale: nessun server, nessun tracciamento. Impostazioni in localStorage.
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------------------------------------------------------------- config */

const APP_VERSION = 6;           // tienila uguale al numero in sw.js (gymtimer-vN)
const STORAGE_KEY = 'gymtimer.v1';

const DEFAULTS = {
  mode: 'tabata',
  tabata: { prep: 10, work: 20, rest: 10, rounds: 8 },
  emom:   { prep: 10, interval: 60, rounds: 10 },
  amrap:  { prep: 10, minutes: 12 },
  fortime: { prep: 10, cap: 15 },
  stopwatch: {},
  sound:  { on: true, volume: 0.8, countdown: true, mid: true, vibrate: true, voice: false },
};

const FIELDS = {
  tabata: [
    { key: 'prep',   label: 'Preparazione', min: 0,  max: 60,  step: 5,  fmt: 'time' },
    { key: 'work',   label: 'Lavoro',       min: 5,  max: 300, step: 5,  fmt: 'time' },
    { key: 'rest',   label: 'Recupero',     min: 0,  max: 300, step: 5,  fmt: 'time' },
    { key: 'rounds', label: 'Round',        min: 1,  max: 50,  step: 1,  fmt: 'n' },
  ],
  emom: [
    { key: 'prep',     label: 'Preparazione',     min: 0,  max: 60,  step: 5,  fmt: 'time' },
    { key: 'interval', label: 'Ogni',             min: 15, max: 300, step: 15, fmt: 'time' },
    { key: 'rounds',   label: 'Round',            min: 1,  max: 60,  step: 1,  fmt: 'n' },
  ],
  amrap: [
    { key: 'prep',    label: 'Preparazione', min: 0, max: 60, step: 5, fmt: 'time' },
    { key: 'minutes', label: 'Durata',       min: 1, max: 90, step: 1, fmt: 'min' },
  ],
  fortime: [
    { key: 'prep', label: 'Preparazione', min: 0, max: 60, step: 5, fmt: 'time' },
    { key: 'cap',  label: 'Time cap',     min: 0, max: 90, step: 1, fmt: 'cap' },
  ],
  stopwatch: [],
};

const MODE_NAMES = { tabata: 'TABATA', emom: 'EMOM', amrap: 'AMRAP', fortime: 'FOR TIME', stopwatch: 'CRONOMETRO' };
const MODE_DESC = {
  tabata: 'Lavoro e recupero a intervalli fissi, per un numero di round. Classico: 20" lavoro / 10" recupero × 8.',
  emom:   'Every Minute On the Minute: a ogni scadenza parte un nuovo round. Quello che avanza è recupero.',
  amrap:  'As Many Rounds As Possible: più giri possibili nel tempo stabilito. Tocca +1 a ogni giro.',
  fortime: 'Completa il lavoro il più in fretta possibile: il tempo sale, tocca FINITO quando hai terminato. Con il time cap suona allo scadere.',
  stopwatch: 'Un semplice cronometro: avvia, ferma e tocca GIRO per segnare i parziali.',
};

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      mode: saved.mode in MODE_NAMES ? saved.mode : DEFAULTS.mode,
      tabata: { ...DEFAULTS.tabata, ...saved.tabata },
      emom:   { ...DEFAULTS.emom,   ...saved.emom },
      amrap:  { ...DEFAULTS.amrap,  ...saved.amrap },
      fortime: { ...DEFAULTS.fortime, ...saved.fortime },
      stopwatch: {},
      sound:  { ...DEFAULTS.sound,  ...saved.sound },
    };
  } catch { return structuredClone(DEFAULTS); }
}
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage pieno/bloccato */ }
}
const state = loadState();
let pendingReload = false;

/* ---------------------------------------------------------------- helpers */

const fmtClock = (sec) => {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};
const fmtElapsed = (sec) => fmtClock(Math.floor(sec));
const fmtValue = (v, kind) => kind === 'time' ? fmtClock(v) : kind === 'min' ? `${v} min` : kind === 'cap' ? (v === 0 ? 'Nessuno' : `${v} min`) : String(v);

function buildSegments(mode, c) {
  const segs = [];
  if (c.prep > 0) segs.push({ type: 'prep', dur: c.prep, label: 'PREPARATI' });

  if (mode === 'tabata') {
    for (let i = 1; i <= c.rounds; i++) {
      segs.push({ type: 'work', dur: c.work, label: 'LAVORO', round: i, rounds: c.rounds });
      if (c.rest > 0 && i < c.rounds) segs.push({ type: 'rest', dur: c.rest, label: 'RECUPERO', round: i, rounds: c.rounds });
    }
  } else if (mode === 'emom') {
    for (let i = 1; i <= c.rounds; i++) {
      segs.push({ type: 'work', dur: c.interval, label: 'VAI', round: i, rounds: c.rounds });
    }
  } else if (mode === 'amrap') {
    segs.push({ type: 'work', dur: c.minutes * 60, label: 'AMRAP', amrap: true });
  } else if (mode === 'stopwatch') {
    segs.push({ type: 'work', dur: Infinity, label: 'CRONOMETRO', stopwatch: true });
  } else {
    segs.push({ type: 'work', dur: c.cap > 0 ? c.cap * 60 : Infinity, label: 'FOR TIME', forTime: true, capped: c.cap > 0 });
  }
  return segs;
}
const totalDuration = (segs) => segs.reduce((a, s) => a + s.dur, 0);

/* ---------------------------------------------------------------- audio */

let ctx = null;
let silentEl = null;
let silentTimer = null;
let scheduledNodes = [];

function makeSilentWavURI() {
  // 1 s a 8 kHz, 16 bit: un'onda a 10 Hz (non udibile) a bassissimo livello. Non è silenzio assoluto,
  // così Android e iOS considerano la pagina "in riproduzione" e non la sospendono a schermo spento.
  const n = 8000, bytes = n * 2, buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
  const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, bytes, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(100 * Math.sin(2 * Math.PI * 10 * i / 8000)), true);
  let bin = ''; new Uint8Array(buf).forEach(x => bin += String.fromCharCode(x));
  return 'data:audio/wav;base64,' + btoa(bin);
}

// Va chiamata dentro un gesto dell'utente (tap su AVVIA): iOS lo richiede.
function initAudio() {
  try {
    clearTimeout(silentTimer);
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      // se il sistema interrompe e poi riavvia l'audio (chiamata, blocco schermo), riallinea i suoni programmati
      ctx.addEventListener('statechange', () => {
        if (ctx.state === 'running' && engine.running) { engine.tick(); if (engine.running) engine.schedule(); }
      });
    }
    if (ctx.state !== 'running') ctx.resume();
    if (!silentEl) { silentEl = new Audio(makeSilentWavURI()); silentEl.loop = true; silentEl.volume = 1; }
    silentEl.play().catch(() => {});
  } catch { /* audio non disponibile */ }
}
function stopSilent(delay = 0) {
  clearTimeout(silentTimer);
  silentTimer = setTimeout(() => { if (!engine.active) { try { silentEl && silentEl.pause(); } catch {} } }, delay);
}

// Scheda sulla schermata di blocco / area notifiche: fase, round e barra del tempo
let mediaKey = '';
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.playbackState = 'playing';
    navigator.mediaSession.setActionHandler('pause', () => { if (engine.active && engine.running) { engine.pause(); ui.renderTimer(); } });
    navigator.mediaSession.setActionHandler('play', () => { if (engine.active && !engine.running) { initAudio(); engine.resume(); ui.renderTimer(); } });
  } catch {}
  mediaKey = ''; refreshMedia(true);
}
function refreshMedia(syncPosition = false) {
  if (!('mediaSession' in navigator) || !engine.active || !engine.seg) return;
  try {
    const s = engine.seg;
    const key = `${engine.mode}|${s.label}|${s.round || 0}`;
    if (key !== mediaKey) {
      mediaKey = key;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: s.label,
        artist: `GymTimer · ${MODE_NAMES[engine.mode]}${s.rounds ? ` · Round ${s.round}/${s.rounds}` : ''}`,
        artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
    }
    if (syncPosition) {
      // la barra avanza da sola, senza che l'app la aggiorni; niente barra se la durata non c'è o se è in pausa
      if (Number.isFinite(engine.totalDur) && engine.running) {
        navigator.mediaSession.setPositionState({ duration: engine.totalDur, playbackRate: 1, position: Math.min(engine.totalMs / 1000, engine.totalDur) });
      } else navigator.mediaSession.setPositionState();
    }
  } catch {}
}
function setMediaState(st) { try { navigator.mediaSession.playbackState = st; } catch {} }
function clearMediaSession() {
  mediaKey = '';
  try { navigator.mediaSession.playbackState = 'none'; navigator.mediaSession.metadata = null; navigator.mediaSession.setPositionState(); } catch {}
}

// Programma un beep sull'orologio audio: suona anche se il JavaScript è rallentato o sospeso in background.
function tone(freq, dur, when = 0, type = 'sine', gain = 1) {
  if (!state.sound.on || !ctx) return;
  const t = ctx.currentTime + when;
  const peak = Math.max(0.0002, state.sound.volume * gain);
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
  g.gain.setValueAtTime(peak, t + Math.max(0.011, dur - 0.06));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(ctx.destination);
  o.onended = () => { try { o.disconnect(); g.disconnect(); } catch {} };
  o.start(t); o.stop(t + dur + 0.03);
  if (scheduledNodes.length > 2000) scheduledNodes = scheduledNodes.filter(n => n.end > ctx.currentTime);
  scheduledNodes.push({ o, g, end: t + dur + 0.03 });
}
function cancelScheduled() {
  const nodes = scheduledNodes; scheduledNodes = [];
  for (const { o, g } of nodes) {
    try { o.stop(); } catch {}
    try { o.disconnect(); g.disconnect(); } catch {}
  }
}

function vibrate(pattern) {
  if (state.sound.vibrate && navigator.vibrate) try { navigator.vibrate(pattern); } catch {}
}
function speak(text) {
  if (!state.sound.voice || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'it-IT'; u.volume = state.sound.volume;
    speechSynthesis.speak(u);
  } catch {}
}

// `at` = secondi da adesso
const SND = {
  tick:   (at = 0) => tone(880, 0.12, at, 'sine', 0.9),
  go:     (at = 0) => tone(1320, 0.75, at, 'square', 0.55),
  rest:   (at = 0) => { tone(600, 0.22, at, 'triangle'); tone(420, 0.4, at + 0.25, 'triangle'); },
  minute: (at = 0) => tone(660, 0.18, at, 'sine', 0.8),
  half:   (at = 0) => { tone(700, 0.15, at); tone(700, 0.15, at + 0.25); },
  warn:   (at = 0) => { [0, 0.25, 0.5].forEach(d => tone(990, 0.15, at + d)); },
  end:    (at = 0) => {
    [0, 0.28, 0.56].forEach(d => tone(1047, 0.2, at + d, 'square', 0.5));
    tone(1568, 1.0, at + 0.9, 'square', 0.55);
  },
};
const VIB = { tick: 40, go: [200], rest: [120, 60, 120], minute: 60, half: [80, 60, 80], warn: [80, 60, 80, 60, 80], end: [300, 100, 300, 100, 600] };
// vibrazione + voce: funzionano solo con la pagina in primo piano (i suoni invece sono già programmati)
function cue(name, text) { vibrate(VIB[name]); if (text) speak(text); }

/* ---------------------------------------------------------------- wake lock */

let wakeLock = null;
async function lockScreen() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { wakeLock = null; }
}
function unlockScreen() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }

/* ---------------------------------------------------------------- engine */

const engine = {
  segs: [], idx: 0, segMs: 0, totalMs: 0, totalDur: 0,
  running: false, active: false, last: 0, handle: null,
  lastCount: null, flags: {}, amrapRounds: 0, mode: 'tabata', cfg: null, capped: false, resultSec: 0, laps: [],

  start(mode, cfg) {
    this.mode = mode; this.cfg = { ...cfg };
    this.segs = buildSegments(mode, cfg);
    this.totalDur = totalDuration(this.segs);
    this.idx = 0; this.segMs = 0; this.totalMs = 0;
    this.amrapRounds = 0; this.lastCount = null; this.flags = {};
    this.capped = false; this.resultSec = 0; this.laps = [];
    this.active = true; this.running = true; this.last = Date.now();   // Date.now: resta corretto anche a telefono bloccato
    clearInterval(this.handle);
    this.handle = setInterval(() => this.tick(), 100);
    this.onSegmentStart(true);
    this.schedule();
  },

  pause() { this.tick(); this.running = false; clearInterval(this.handle); cancelScheduled(); setMediaState('paused'); refreshMedia(true); },
  resume() {
    this.running = true; this.last = Date.now();
    clearInterval(this.handle);
    this.handle = setInterval(() => this.tick(), 100);
    this.schedule(); setMediaState('playing'); refreshMedia(true);
  },
  stop() { this.running = false; this.active = false; clearInterval(this.handle); cancelScheduled(); clearMediaSession(); },

  get seg() { return this.segs[this.idx]; },

  // Tutti i suoni futuri vengono programmati subito sull'orologio audio.
  schedule() {
    cancelScheduled();
    if (!ctx || !this.running || !this.seg) return;
    for (const e of this.audioEvents()) SND[e.snd](e.t);
  },

  // Elenco dei suoni da qui alla fine: { t: secondi da adesso, snd: nome }
  audioEvents() {
    const evs = [], LIMIT = 7200;                        // non pianificare oltre 2 ore
    const add = (t, snd) => { if (t >= -0.02 && t <= LIMIT) evs.push({ t: Math.max(0, t), snd }); };
    let S = -this.segMs / 1000;                          // inizio del segmento corrente rispetto ad ora
    for (let i = this.idx; i < this.segs.length; i++) {
      const s = this.segs[i], dur = s.dur;
      if (s.type === 'work' && s.stopwatch) add(S, 'tick');
      else if (s.type === 'work') add(S, 'go');
      else if (s.type === 'rest') add(S, 'rest');
      if (Number.isFinite(dur)) {
        if (state.sound.countdown && dur > 3) [3, 2, 1].forEach(k => add(S + dur - k, 'tick'));
        if (state.sound.mid && s.type === 'work' && (this.mode === 'tabata' || this.mode === 'emom') && dur >= 10) add(S + dur / 2, 'half');
        if (s.amrap) {
          if (dur >= 120) add(S + dur / 2, 'half');
          if (dur > 150) add(S + dur - 60, 'warn');
        }
      }
      if (s.forTime) {
        const warnAt = (s.capped && dur > 150) ? dur - 60 : null;
        if (warnAt !== null) add(S + warnAt, 'warn');
        const maxMin = Number.isFinite(dur) ? Math.floor((dur - 1) / 60) : 120;
        for (let m = 1; m <= maxMin; m++) { if (warnAt !== null && m * 60 === warnAt) continue; add(S + m * 60, 'minute'); }
      }
      S += dur;
      if (!Number.isFinite(dur)) return evs;             // cronometro / For Time senza cap: nessuna fine
    }
    add(S, 'end');
    return evs;
  },

  onSegmentStart(timely = true) {
    const s = this.seg;
    this.lastCount = null; this.flags = {};
    if (!timely) return;                                 // tornati dal background: niente vibrazione/voce in ritardo
    if (s.type === 'work' && s.stopwatch) cue('tick');
    else if (s.type === 'work') cue('go', this.mode === 'tabata' ? 'Lavoro' : 'Via');
    else if (s.type === 'rest') cue('rest', 'Recupero');
    else if (s.type === 'prep') speak('Preparati');
  },

  tick() {
    if (!this.running) return;
    const now = Date.now();
    const dt = Math.max(0, now - this.last); this.last = now;
    this.segMs += dt; this.totalMs += dt;

    let advanced = false;
    while (this.segMs >= this.seg.dur * 1000) {
      this.segMs -= this.seg.dur * 1000;
      this.idx++;
      if (this.idx >= this.segs.length) { this.finish(); return; }
      advanced = true;
    }
    if (advanced) { this.onSegmentStart(this.segMs < 1500); refreshMedia(true); }

    const s = this.seg;
    const remaining = Math.ceil((s.dur * 1000 - this.segMs) / 1000);

    // vibrazione e voce (i suoni veri sono già programmati da schedule())
    if (state.sound.countdown && s.dur > 3 && remaining <= 3 && remaining >= 1 && remaining !== this.lastCount) {
      this.lastCount = remaining; cue('tick');
    }
    if (state.sound.mid && s.type === 'work' && (this.mode === 'tabata' || this.mode === 'emom') && s.dur >= 10 && !this.flags.mid) {
      const half = s.dur * 500;
      if (this.segMs >= half) { this.flags.mid = true; if (this.segMs < half + 1500) cue('half', 'Metà'); }
    }
    if (s.amrap) {
      const left = s.dur - this.segMs / 1000;
      if (!this.flags.half && s.dur >= 120 && left <= s.dur / 2) { this.flags.half = true; cue('half', 'Metà tempo'); }
      if (!this.flags.min && s.dur > 150 && left <= 60) { this.flags.min = true; cue('warn', 'Ultimo minuto'); }
    }
    if (s.forTime && s.type === 'work') {
      const minute = Math.floor(this.segMs / 60000);
      const left = s.dur - this.segMs / 1000;
      if (s.capped && !this.flags.warn && s.dur > 150 && left <= 60) {
        this.flags.warn = true; this.flags.minute = minute; cue('warn', 'Ultimo minuto');
      } else if (minute >= 1 && minute !== this.flags.minute) {
        this.flags.minute = minute; cue('minute');
      }
    }
    ui.renderTimer();
  },

  finish() {                                             // fine naturale: il suono finale è già programmato
    this.running = false; this.active = false; clearInterval(this.handle);
    this.capped = this.mode === 'fortime';               // arrivati a fine segmento = time cap
    cue('end', this.capped ? 'Time cap' : 'Finito');
    clearMediaSession();
    ui.showDone();
  },

  // Cronometro: segna un parziale
  lap() {
    if (!this.running || !this.seg.stopwatch) return;
    const total = this.segMs / 1000;
    const last = this.laps.length ? this.laps[0].total : 0;
    this.laps.unshift({ n: this.laps.length + 1, split: total - last, total });
    vibrate(30);
    ui.renderTimer();
  },

  // For Time: l'atleta ha finito prima del cap
  finishNow() {
    this.tick();
    if (!this.running) return;                           // il tick ha già chiuso (cap raggiunto)
    this.running = false; this.active = false; clearInterval(this.handle);
    cancelScheduled();                                   // via i beep dei minuti e il finale programmato
    this.capped = false; this.resultSec = Math.floor(this.segMs / 1000);
    SND.end(); cue('end', 'Finito');
    clearMediaSession();
    ui.showDone();
  },

  nextSeg() { return this.segs[this.idx + 1] || null; },
  totalRemaining() { return Math.max(0, this.totalDur - this.totalMs / 1000); },
};

/* ---------------------------------------------------------------- UI */

const ui = {
  show(id) {
    if (id === 'setup' && pendingReload) { location.reload(); return; }
    $$('.screen').forEach(el => el.classList.toggle('active', el.id === id));
  },

  renderSetup() {
    document.body.dataset.mode = state.mode;
    $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.mode === state.mode));
    $('#mode-desc').textContent = MODE_DESC[state.mode];

    const box = $('#fields');
    box.innerHTML = '';
    for (const f of FIELDS[state.mode]) {
      const row = document.createElement('div');
      row.className = 'field';
      row.innerHTML = `
        <span class="name">${f.label}</span>
        <div class="stepper">
          <button data-d="-1" aria-label="Diminuisci ${f.label}">−</button>
          <output>${fmtValue(state[state.mode][f.key], f.fmt)}</output>
          <button data-d="1" aria-label="Aumenta ${f.label}">+</button>
        </div>`;
      row.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
          const cur = state[state.mode][f.key];
          const next = Math.min(f.max, Math.max(f.min, cur + Number(btn.dataset.d) * f.step));
          state[state.mode][f.key] = next;
          saveState();
          row.querySelector('output').textContent = fmtValue(next, f.fmt);
          ui.renderTotal();
        });
      });
      box.appendChild(row);
    }
    ui.renderTotal();
  },

  renderTotal() {
    const segs = buildSegments(state.mode, state[state.mode]);
    const tot = totalDuration(segs);
    $('.summary').hidden = state.mode === 'stopwatch';
    $('#total-label').textContent = state.mode === 'fortime' ? 'Durata massima' : 'Durata totale';
    $('#total-time').textContent = Number.isFinite(tot) ? fmtClock(tot) : 'Senza limite';
  },

  renderTimer() {
    const s = engine.seg;
    if (!s) return;
    const el = $('#timer');
    el.classList.remove('prep', 'work', 'rest');
    [...el.classList].filter(c => c.startsWith('m-')).forEach(c => el.classList.remove(c));
    el.classList.add(s.type, 'm-' + engine.mode);
    el.classList.toggle('paused', !engine.running);

    $('#t-mode').textContent = MODE_NAMES[engine.mode];
    $('#t-round').textContent = s.rounds ? `Round ${s.round}/${s.rounds}`
      : s.amrap ? `Giri ${engine.amrapRounds}`
      : s.forTime ? (s.capped ? `Cap ${fmtClock(s.dur)}` : 'Senza cap')
      : s.stopwatch ? `Giri ${engine.laps.length}` : '';
    $('#t-label').textContent = s.label;
    $('#t-time').textContent = (s.forTime || s.stopwatch) ? fmtElapsed(engine.segMs / 1000) : fmtClock((s.dur * 1000 - engine.segMs) / 1000);

    const n = engine.nextSeg();
    $('#t-next').textContent = n ? `Poi: ${n.label} ${Number.isFinite(n.dur) ? fmtClock(n.dur) : ''}`.trim()
      : s.forTime ? 'Tocca FINITO quando hai terminato' : (s.amrap || s.stopwatch ? '' : 'Ultimo!');
    const rem = engine.totalRemaining();
    $('#t-total').textContent = Number.isFinite(rem) ? fmtClock(rem) : '—';
    $('#t-bar').style.width = `${Math.min(100, (engine.totalMs / 1000 / engine.totalDur) * 100)}%`;

    $('#amrap-box').hidden = !(engine.mode === 'amrap' && s.type === 'work');
    $('#amrap-n').textContent = engine.amrapRounds;
    $('#ft-box').hidden = !(engine.mode === 'fortime' && s.type === 'work');
    $('#sw-box').hidden = !s.stopwatch;
    $('.progress').hidden = !!s.stopwatch;
    $('.total-line').hidden = !!s.stopwatch;
    if (s.stopwatch) {
      $('#lap-list').innerHTML = engine.laps.slice(0, 3)
        .map(l => `<li><span>Giro ${l.n} · ${fmtElapsed(l.split)}</span><span>totale ${fmtElapsed(l.total)}</span></li>`).join('');
    }

    $('#btn-pause').textContent = engine.running ? 'PAUSA' : 'RIPRENDI';
    $('#btn-exit').hidden = engine.running;
  },

  showDone() {
    unlockScreen(); stopSilent(3000);      // lascia finire il suono finale prima di fermare l'audio
    let txt = `${MODE_NAMES[engine.mode]} · ${Number.isFinite(engine.totalDur) ? fmtClock(engine.totalDur) : 'senza cap'}`;
    if (engine.mode === 'amrap') txt += `\n<b>${engine.amrapRounds}</b>\ngiri completati`;
    if (engine.mode === 'fortime') {
      txt = engine.capped
        ? `${MODE_NAMES[engine.mode]}\n<b>Time cap</b>\nraggiunto`
        : `${MODE_NAMES[engine.mode]}\n<b>${fmtElapsed(engine.resultSec)}</b>\ntempo finale`;
    }
    $('#done-summary').innerHTML = txt;
    ui.show('done');
  },
};

/* ---------------------------------------------------------------- eventi */

function startWorkout() {
  initAudio();           // dentro il gesto utente
  lockScreen();
  ui.show('timer');
  engine.start(state.mode, state[state.mode]);
  setupMediaSession();
  ui.renderTimer();
}
function exitWorkout() {
  engine.stop(); unlockScreen(); stopSilent();
  try { speechSynthesis.cancel(); } catch {}
  ui.show('setup');
}

$$('.tabs button').forEach(b => b.addEventListener('click', () => {
  state.mode = b.dataset.mode; saveState(); ui.renderSetup();
}));
$('#btn-start').addEventListener('click', startWorkout);
$('#btn-again').addEventListener('click', startWorkout);
$('#btn-close').addEventListener('click', () => ui.show('setup'));
$('#btn-exit').addEventListener('click', exitWorkout);

$('#btn-pause').addEventListener('click', () => {
  if (engine.running) { engine.pause(); }
  else { initAudio(); lockScreen(); engine.resume(); }
  ui.renderTimer();
});
$('#btn-lap').addEventListener('click', () => engine.lap());
$('#btn-finish').addEventListener('click', () => engine.finishNow());
$('#btn-plus').addEventListener('click', () => { engine.amrapRounds++; vibrate(30); ui.renderTimer(); });
$('#btn-minus').addEventListener('click', () => { engine.amrapRounds = Math.max(0, engine.amrapRounds - 1); ui.renderTimer(); });

// impostazioni
const S = state.sound;
function openSettings() {
  $('#app-version').textContent = `GymTimer v${APP_VERSION}`;
  $('#s-sound').checked = S.on;
  $('#s-volume').value = S.volume;
  $('#s-countdown').checked = S.countdown;
  $('#s-mid').checked = S.mid;
  $('#s-vibrate').checked = S.vibrate;
  $('#s-voice').checked = S.voice;
  $('#settings').hidden = false;
}
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-settings-close').addEventListener('click', () => { $('#settings').hidden = true; });
$('#s-sound').addEventListener('change', e => { S.on = e.target.checked; saveState(); });
$('#s-volume').addEventListener('input', e => { S.volume = Number(e.target.value); saveState(); });
$('#s-countdown').addEventListener('change', e => { S.countdown = e.target.checked; saveState(); });
$('#s-mid').addEventListener('change', e => { S.mid = e.target.checked; saveState(); });
$('#s-vibrate').addEventListener('change', e => { S.vibrate = e.target.checked; saveState(); });
$('#s-voice').addEventListener('change', e => { S.voice = e.target.checked; saveState(); });
$('#btn-test').addEventListener('click', () => {
  initAudio();
  SND.tick(); setTimeout(SND.go, 500); setTimeout(SND.rest, 1500); setTimeout(SND.end, 2500);
});

// rientro in app: riprendi wake lock e riallinea il timer
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && engine.running) {
    lockScreen();
    if (ctx && ctx.state !== 'running') ctx.resume();
    engine.tick();
    if (engine.running) { engine.schedule(); refreshMedia(true); }     // riallinea suoni e barra all'orologio reale
  }
});

/* ---------------------------------------------------------------- installazione + offline */

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e;
  $('#btn-install').hidden = false;
});
$('#btn-install').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice.catch(() => {});
  deferredPrompt = null; $('#btn-install').hidden = true;
});
window.addEventListener('appinstalled', () => { $('#btn-install').hidden = true; $('#install-hint').hidden = true; });

const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIOS && !isStandalone) {
  const h = $('#install-hint');
  h.textContent = 'Per installarla su iPhone: tocca Condividi (□↑) e poi "Aggiungi a Home".';
  h.hidden = false;
}

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  // quando arriva una nuova versione ricarica da sola (ma mai durante un allenamento)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;                       // primo install: niente reload
    if ($('#setup').classList.contains('active')) location.reload();
    else pendingReload = true;                        // lo faremo al ritorno alla schermata iniziale
  });
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

ui.renderSetup();
