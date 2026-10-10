// Fallback for event titles the parser reads with low confidence (see confidence.js):
// asks an LLM to read the title, given the classes and rooms that exist.
// Any OpenAI-compatible chat API: Groq by default (free tier, fast), or Mistral with
//   AI_BASE_URL=https://api.mistral.ai/v1  AI_MODEL=mistral-small-latest
// Off unless AI_API_KEY is set. Only the event title and the class/room names are sent.
// Answers are checked against the timetable and cached per title.
import logger from '../logger.js';
import { entityKey, roomNumber, sameRoom } from './normalize.js';

const log = logger.child('timetable:ai');

const API_KEY = process.env.AI_API_KEY;
const BASE_URL = (process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const MODEL = process.env.AI_MODEL || 'openai/gpt-oss-120b';
// Used in order: when one model's free daily quota is over, the next one answers.
// (On Groq quotas are per model; openai/gpt-oss-20b is left to the other projects on the key.)
const MODELS = [
  MODEL,
  ...(process.env.AI_FALLBACK_MODELS ?? (process.env.AI_BASE_URL ? '' : 'qwen/qwen3.8-27b'))
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m && m !== MODEL),
];
const modelPause = new Map(); // model -> paused until (ms), after a 429 or with no tokens left
const MAX_CACHE = 5000;
const RETRY_MS = 30 * 60 * 1000; // after a failure, ask again only later

export const aiEnabled = () => Boolean(API_KEY);

const KINDS = {
  change: null,
  entry: 'Entrata posticipata',
  exit: 'Uscita anticipata',
  trip: 'Uscita didattica',
  study: 'Studio autonomo',
};

const cache = new Map(); // summary -> { result } | { pending: Promise } | { failedAt }

// --- persistence: table timetable_ai_readings (migrations/2026-10-09-…) -----------------
// Shared by every instance (prod, staging): a title is sent to the AI once per prompt version.
// Bump PROMPT_VERSION when the prompt or the validation changes: titles are read again.
const PROMPT_VERSION = 3;
// Loaded on first use: the parser and its tests never need the database.
const db = () => import('../../db.js').then((m) => m.default);

async function loadCache() {
  try {
    const pool = await db();
    const { rows } = await pool.query('SELECT summary, result FROM timetable_ai_readings WHERE prompt_version = $1', [PROMPT_VERSION]);
    for (const r of rows) if (!cache.get(r.summary)?.result) cache.set(r.summary, { result: r.result });
    // Today's usage, across instances: the daily budget is per API key.
    const recent = await pool.query("SELECT created_at FROM timetable_ai_readings WHERE created_at > now() - interval '24 hours'");
    sent.push(...recent.rows.map((r) => r.created_at.getTime()));
    sent.sort((a, b) => a - b);
    log.info('AI readings loaded', { results: rows.length, sentToday: recent.rows.length });
  } catch (err) {
    log.warn('AI readings not loaded', { error: err.message });
  }
}

/** Reading saved by another instance (or before a restart), if any. */
async function storedReading(summary) {
  try {
    const { rows } = await (await db()).query('SELECT result FROM timetable_ai_readings WHERE summary = $1 AND prompt_version = $2', [summary, PROMPT_VERSION]);
    return rows[0]?.result || null;
  } catch {
    return null;
  }
}

function saveReading(summary, result) {
  db()
    .then((pool) => pool.query(
      'INSERT INTO timetable_ai_readings (summary, prompt_version, model, result) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [summary, PROMPT_VERSION, result.model, result]
    ))
    .catch((err) => log.warn('AI reading not saved', { error: err.message }));
}

// Shape of the JSON answer, described to the model in the prompt.
const SCHEMA = {
  input_schema: {
    type: 'object',
    properties: {
      classes: { type: 'array', items: { type: 'string' }, description: 'Classi coinvolte, scelte SOLO dall’elenco fornito (nome esatto). Vuoto se nessuna.' },
      group: { type: ['string', 'null'], description: 'Se riguarda solo una parte della classe (es. "alunni IRC"), altrimenti null.' },
      kind: { type: 'string', enum: Object.keys(KINDS), description: 'change = cambio aula/docente/attività; entry = entrata posticipata; exit = uscita anticipata; trip = classe fuori (uscita didattica, viaggio, PCTO); study = studio autonomo.' },
      label: { type: ['string', 'null'], description: 'Etichetta breve per entry/exit/trip/study (es. "Uscita didattica", "PCTO"), null per change.' },
      room: { type: ['string', 'null'], description: 'Aula/luogo dove si svolge: nome esatto dall’elenco aule se presente, altrimenti il luogo come scritto (es. "Aula Magna"), null se non indicato.' },
      teachers: { type: 'array', items: { type: 'string' }, description: 'Cognomi dei docenti presenti/supplenti, in formato "Cognome".' },
      absent: { type: 'array', items: { type: 'string' }, description: 'Cognomi dei docenti assenti.' },
      confidence: { type: 'integer', minimum: 0, maximum: 100, description: 'Quanto sei sicuro dell’interpretazione.' },
      reason: { type: 'string', description: 'Una frase: cosa hai corretto o interpretato.' },
    },
    required: ['classes', 'group', 'kind', 'label', 'room', 'teachers', 'absent', 'confidence', 'reason'],
  },
};

// Only the classes and rooms the title could mean go into the prompt: the whole list is
// ~2500 tokens, and the free tier limits tokens per minute.
function candidates(summary, index) {
  const upper = summary.toUpperCase();
  const tokens = upper.match(/\b[1-5][A-Z]{1,8}\b/g) || [];
  const sections = new Set(tokens.map((t) => t.slice(0, 2)));
  const years = new Set(tokens.map((t) => t[0]));
  let classes = index.classes.filter((c) => sections.has(c.key.slice(0, 2)));
  if (!classes.length) classes = index.classes.filter((c) => years.has(c.key[0]));
  const numbers = new Set(upper.match(/\d{1,3}/g) || []);
  const words = new Set((upper.match(/[A-Z]{4,}/g) || []).filter((w) => !['AULA', 'CLASSE', 'CLASSI', 'PROF', 'PROFF', 'SALA', 'LABORATORIO'].includes(w)));
  const rooms = index.rooms.filter((r) => {
    const name = r.name.toUpperCase();
    return (name.match(/\d+/g) || []).some((n) => numbers.has(n)) || [...words].some((w) => name.includes(w));
  });
  return { classes: classes.slice(0, 40), rooms: rooms.slice(0, 20) };
}

function prompt(summary, fullIndex) {
  const index = candidates(summary, fullIndex);
  return `Sei il parser delle variazioni d’orario dell’IS E. Fermi di Mantova. Il formato abituale dei titoli è:
"CLASSE 3AIIN - AULA 46 - PROF. ROSSI (PROF.ssa BIANCHI: ASSENTE)", "CLASSI 5C, 5D - USCITA DIDATTICA - PROFF. A, B", "CLASSE 4EAU - USCITA ANTICIPATA".
I titoli possono avere errori di battitura, classi scritte in modo diverso, trattini mancanti.
Regole sul tipo (kind): "exit" SOLO se c’è scritto USCITA ANTICIPATA, "entry" SOLO per ENTRATA/INGRESSO POSTICIPATO.
"(ANTICIPA 8' ORA)" significa che la lezione dell’8ª ora si fa prima, in questa ora: è kind "change", non un’uscita né un’entrata.
I nomi dei docenti vanno riportati esattamente come scritti (non correggere i cognomi).

Classi esistenti che potrebbero corrispondere (nome come sul sito):
${index.classes.map((c) => c.name).join(' | ') || '(nessuna simile: la classe scritta non esiste)'}

Aule esistenti che potrebbero corrispondere:
${index.rooms.map((r) => r.name).join(' | ') || '(nessuna: se è indicato un luogo, riportalo come scritto)'}

Interpreta questo titolo e rispondi SOLO con un oggetto JSON con questi campi:
${JSON.stringify(SCHEMA.input_schema.properties, null, 1)}
Se una classe non corrisponde con sicurezza a nessuna dell’elenco, non inventarla.

Titolo: ${JSON.stringify(summary)}`;
}

/** Keeps only what can be trusted: classes that exist, a known kind, plain strings. */
function validate(out, index, model) {
  // By name ("2A me") or key ("2AME"): both spellings come back.
  const byKey = new Map(index.classes.flatMap((c) => [[entityKey(c.name), c.key], [c.key, c.key]]));
  const classes = [...new Set((Array.isArray(out.classes) ? out.classes : []).map((n) => byKey.get(entityKey(n))).filter(Boolean))];
  const kind = Object.hasOwn(KINDS, out.kind) ? out.kind : 'change';
  const roomText = typeof out.room === 'string' ? out.room.trim().slice(0, 80) : '';
  const known = roomText && index.rooms.find((r) => r.name.toUpperCase() === roomText.toUpperCase() || sameRoom(roomText, r.name));
  const room = known ? known.name : roomText || null;
  // Same spelling as the parser: "ROSSI" → "Rossi", "DEL GAIZO" → "Del Gaizo".
  const titleCase = (n) => n.toLowerCase().replace(/(^|[\s'(.-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
  const names = (a) =>
    Array.isArray(a) ? a.filter((n) => typeof n === 'string' && n.trim()).map((n) => titleCase(n.trim().slice(0, 60))).slice(0, 10) : [];
  return {
    classes,
    group: typeof out.group === 'string' && out.group.trim() ? out.group.trim().slice(0, 60) : null,
    kind,
    label: kind === 'change' ? null : (typeof out.label === 'string' && out.label.trim().slice(0, 40)) || KINDS[kind],
    room,
    roomNumber: room ? roomNumber(room) : null,
    teachers: names(out.teachers),
    absent: names(out.absent),
    confidence: Number.isInteger(out.confidence) ? Math.max(0, Math.min(100, out.confidence)) : null,
    reason: typeof out.reason === 'string' ? out.reason.slice(0, 300) : '',
    model,
  };
}

/** First model not paused, or null. */
function pickModel(now = Date.now()) {
  return MODELS.find((m) => (modelPause.get(m) || 0) <= now) || null;
}

async function ask(summary, index) {
  const model = pickModel();
  if (!model) throw new RateLimited('All AI models paused');
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      temperature: 0,
      // gpt-oss models think before answering: keep it short (Groq option; others ignore it)
      ...(/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}),
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt(summary, index) }],
    }),
    signal: AbortSignal.timeout(20000),
  });
  pauseOnLowTokens(res.headers, model);
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after')) || 60;
    modelPause.set(model, Date.now() + retry * 1000);
    const why = (await res.json().catch(() => ({})))?.error?.message || '';
    throw new RateLimited(`AI API 429 (${model}), paused ${retry}s: ${why.slice(0, 160)}`);
  }
  if (!res.ok) throw new Error(`AI API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty AI response');
  return validate(JSON.parse(text), index, model);
}

// --- budget + background queue ------------------------------------------------------
// Below the provider's free limits (Groq: 30/min, 1000/day per account, shared with other
// projects using the same key), leaving headroom.
// Groq free tier, per model: 1000 requests/day and 8000 tokens/minute (one check ≈ 700
// tokens). The token limit is followed from the response headers (pauseOnLowTokens).
const MAX_PER_MINUTE = Number(process.env.AI_MAX_PER_MINUTE) || 10;
const MAX_PER_DAY = Number(process.env.AI_MAX_PER_DAY) || 900;
const MIN_TOKENS = 1200; // pause when fewer tokens than one more check are left this minute
const sent = []; // timestamps of requests in the last 24h

function budgetWait(now = Date.now()) {
  while (sent.length && sent[0] < now - 24 * 3600 * 1000) sent.shift();
  if (!pickModel(now)) return Math.min(...MODELS.map((m) => modelPause.get(m) || 0)) - now;
  if (sent.length >= MAX_PER_DAY) return sent[0] + 24 * 3600 * 1000 - now;
  const lastMinute = sent.filter((t) => t > now - 60 * 1000);
  if (lastMinute.length >= MAX_PER_MINUTE) return lastMinute[0] + 60 * 1000 - now;
  return 0;
}

class RateLimited extends Error {}

/** "51.765s", "1m26.4s", "577ms" → milliseconds */
function durationMs(text) {
  let ms = 0;
  for (const [, n, unit] of String(text || '').matchAll(/([\d.]+)(ms|h|m|s)/g)) {
    ms += Number(n) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  }
  return ms;
}

/** Stop before the provider's tokens-per-minute limit instead of hitting 429s. */
function pauseOnLowTokens(headers, model) {
  const left = Number(headers.get('x-ratelimit-remaining-tokens'));
  if (Number.isFinite(left) && left < MIN_TOKENS) {
    const until = Date.now() + (durationMs(headers.get('x-ratelimit-reset-tokens')) || 30000);
    modelPause.set(model, Math.max(modelPause.get(model) || 0, until));
  }
}

async function askCounted(summary, index) {
  sent.push(Date.now());
  return ask(summary, index);
}

function store(summary, promise) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  const pending = promise
    .then((result) => {
      cache.set(summary, { result });
      saveReading(summary, result);
      log.info('AI read event', { summary, classes: result.classes, room: result.room, confidence: result.confidence });
      return result;
    })
    .catch((err) => {
      if (err instanceof RateLimited) {
        cache.delete(summary); // not the title's fault: ask again later
        queued.set(summary, queued.get(summary) || { index: lastIndex, priority: 0 });
      } else cache.set(summary, { failedAt: Date.now() });
      log.warn('AI read failed', { error: err.message });
      return null;
    });
  cache.set(summary, { pending });
  return pending;
}

const queued = new Map(); // summary -> { index, priority } (lower = sooner)
let lastIndex = null;
let timer = null;

function schedule(delay = 0) {
  if (timer || !queued.size) return;
  timer = setTimeout(drain, delay);
  timer.unref?.();
}

async function drain() {
  timer = null;
  if (!queued.size) return;
  const wait = budgetWait();
  if (wait > 0) return schedule(wait + 50);
  const [summary, item] = [...queued].sort((a, b) => a[1].priority - b[1].priority)[0];
  queued.delete(summary);
  const saved = await storedReading(summary);
  if (saved) {
    cache.set(summary, { result: saved });
    return schedule();
  }
  await store(summary, askCounted(summary, item.index));
  schedule(Math.ceil(60000 / MAX_PER_MINUTE)); // spread requests over the minute
}

/** Cached AI reading, or null. */
export function aiCached(summary) {
  return cache.get(summary)?.result || null;
}

/** 'done' | 'queued' | 'failed' | 'off' */
export function aiState(summary) {
  if (!API_KEY) return 'off';
  const hit = cache.get(summary);
  if (hit?.result) return 'done';
  if (hit?.pending || queued.has(summary)) return 'queued';
  if (hit?.failedAt) return 'failed';
  return 'off';
}

/**
 * Queues a title for a background AI reading (double check), within the budget.
 * Lower `priority` goes first: the parser's confidence score, so doubtful titles lead.
 */
export function aiQueue(summary, index, { priority = 100 } = {}) {
  if (!API_KEY) return;
  lastIndex = index;
  const hit = cache.get(summary);
  if (hit?.result || hit?.pending || (hit?.failedAt && Date.now() - hit.failedAt < RETRY_MS)) return;
  const prev = queued.get(summary);
  queued.set(summary, { index, priority: Math.min(priority, prev?.priority ?? Infinity) });
  schedule();
}

/**
 * AI reading of a title now (test page), if the budget allows; else it is queued first.
 * @param {{classes:{key,name}[], rooms:{key,name}[]}} index
 */
export async function aiInterpret(summary, index) {
  if (!API_KEY) return null;
  const hit = cache.get(summary);
  if (hit?.result) return hit.result;
  if (hit?.pending) return hit.pending;
  if (hit?.failedAt && Date.now() - hit.failedAt < RETRY_MS) return null;
  if (budgetWait() > 0) {
    aiQueue(summary, index, { priority: -1 });
    return null;
  }
  queued.delete(summary);
  return store(summary, askCounted(summary, index));
}

/** Budget usage, for the test page. */
export function aiBudget() {
  const now = Date.now();
  budgetWait(now);
  return {
    lastMinute: sent.filter((t) => t > now - 60000).length,
    perMinute: MAX_PER_MINUTE,
    today: sent.length,
    perDay: MAX_PER_DAY,
    queued: queued.size,
    paused: !pickModel(now),
    models: MODELS.map((m) => ({ model: m, paused: (modelPause.get(m) || 0) > now })),
  };
}

// --- retention ------------------------------------------------------------------------
// A reading is kept while its title is on the calendar: titles repeat over days, so the age
// of the row says nothing. Titles in use are marked (batched), and rows not seen for
// KEEP_DAYS, or from an older prompt version, are deleted once a day.
const KEEP_DAYS = Number(process.env.AI_KEEP_DAYS) || 14;
const SEEN_FLUSH_MS = 10 * 60 * 1000;
const seen = new Set();
const seenFlushed = new Map(); // summary -> last flush (ms): mark each title at most hourly

/** Titles currently on the calendar that already have a reading. */
export function aiMarkSeen(summaries) {
  if (!API_KEY) return;
  const now = Date.now();
  for (const s of summaries) {
    if (cache.get(s)?.result && now - (seenFlushed.get(s) || 0) > 3600 * 1000) seen.add(s);
  }
}

async function flushSeen() {
  if (!seen.size) return;
  const list = [...seen];
  seen.clear();
  const now = Date.now();
  list.forEach((s) => seenFlushed.set(s, now));
  try {
    await (await db()).query(
      'UPDATE timetable_ai_readings SET last_seen = now() WHERE prompt_version = $1 AND summary = ANY($2)',
      [PROMPT_VERSION, list]
    );
  } catch (err) {
    log.warn('AI last_seen not saved', { error: err.message });
  }
}

async function cleanup() {
  await flushSeen();
  try {
    const { rowCount } = await (await db()).query(
      "DELETE FROM timetable_ai_readings WHERE prompt_version <> $1 OR last_seen < now() - make_interval(days => $2)",
      [PROMPT_VERSION, KEEP_DAYS]
    );
    if (rowCount) log.info('Old AI readings deleted', { rows: rowCount });
  } catch (err) {
    log.warn('AI readings cleanup failed', { error: err.message });
  }
}

if (API_KEY) {
  loadCache();
  setInterval(flushSeen, SEEN_FLUSH_MS).unref?.();
  // Daily, starting a few minutes after boot (instances restarting together do it once more, harmless).
  setTimeout(() => {
    cleanup();
    setInterval(cleanup, 24 * 3600 * 1000).unref?.();
  }, 5 * 60 * 1000).unref?.();
}
