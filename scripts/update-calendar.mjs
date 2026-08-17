/**
 * Weekly refresh for the Catalyst Calendar.
 *
 * Design rule: this script only ever touches machine-verifiable fields —
 * prices, event dates, and the confirmed/estimated flag. It never rewrites a
 * `title`, a `desc`, or a `src`, because those hold hand-written research the
 * APIs cannot reproduce. It never deletes an event. If a data source fails,
 * the corresponding values are left exactly as they were.
 *
 * Run:  node scripts/update-calendar.mjs [--dry]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'index.html');
const DRY = process.argv.includes('--dry');

/* How far an API date may sit from an existing event and still be considered
   the same event. Earnings slip by days, not months; a wider window would
   risk matching Q3 earnings onto the Q4 row. */
const MATCH_DAYS = 45;

const changes = [];
const problems = [];

const todayISO = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);
const isISO = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/* ------------------------------------------------------------------ *
 * Data sources. Yahoo needs no key and is tried first; Finnhub fills in
 * only if FINNHUB_TOKEN is set. Each returns {} on failure so a dead
 * source degrades into "no changes" rather than a broken page.
 * ------------------------------------------------------------------ */

async function yahooFacts(tickers) {
  const out = {};
  let yf;
  try {
    const { default: YahooFinance } = await import('yahoo-finance2');
    yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  } catch (err) {
    problems.push(`yahoo-finance2 unavailable — skipped Yahoo (${err.message})`);
    return out;
  }

  for (const t of tickers) {
    try {
      const q = await yf.quoteSummary(t, { modules: ['price', 'calendarEvents', 'summaryDetail'] });
      const price = q?.price?.regularMarketPrice;
      const prev = q?.price?.regularMarketPreviousClose;
      const earnings = q?.calendarEvents?.earnings?.earningsDate?.[0];
      const exDiv = q?.calendarEvents?.exDividendDate ?? q?.summaryDetail?.exDividendDate;
      const payDiv = q?.calendarEvents?.dividendDate;

      out[t] = {
        price: Number.isFinite(price) ? price : undefined,
        prev: Number.isFinite(prev) ? prev : undefined,
        earnings: earnings ? new Date(earnings).toISOString().slice(0, 10) : undefined,
        /* Yahoo flags an earnings date as estimated when the company has not
           announced it; only a confirmed date should flip an event to 'C'. */
        earningsConfirmed: q?.calendarEvents?.earnings?.isEarningsDateEstimate === false,
        exDiv: exDiv ? new Date(exDiv).toISOString().slice(0, 10) : undefined,
        payDiv: payDiv ? new Date(payDiv).toISOString().slice(0, 10) : undefined
      };
    } catch (err) {
      problems.push(`Yahoo ${t}: ${err.message}`);
    }
  }
  return out;
}

async function finnhubFacts(tickers, token) {
  const out = {};
  const from = todayISO();
  const to = '2026-12-31';

  for (const t of tickers) {
    try {
      const url = `https://finnhub.io/api/v1/calendar/earnings?symbol=${encodeURIComponent(t)}`
                + `&from=${from}&to=${to}&token=${token}`;
      const res = await fetch(url);
      if (!res.ok) { problems.push(`Finnhub ${t}: HTTP ${res.status}`); continue; }
      const body = await res.json();
      const next = (body?.earningsCalendar || [])
        .map(e => e.date).filter(isISO).sort()[0];
      if (next) out[t] = { earnings: next, earningsConfirmed: true };
    } catch (err) {
      problems.push(`Finnhub ${t}: ${err.message}`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Surgical rewrites against the page text.
 * ------------------------------------------------------------------ */

/** Replace price/prev on the POSITIONS row for one ticker. */
function updatePrice(html, ticker, price, prev) {
  if (!Number.isFinite(price) || !Number.isFinite(prev)) return html;
  const row = new RegExp(`(\\{t:'${ticker}',[^\\n]*?price:)([\\d.]+)(,\\s*prev:)([\\d.]+)`);
  const m = html.match(row);
  if (!m) { problems.push(`no POSITIONS row for ${ticker}`); return html; }

  const round = n => Math.round(n * 1000) / 1000;
  const [oldPrice, oldPrev] = [Number(m[2]), Number(m[4])];
  const [newPrice, newPrev] = [round(price), round(prev)];
  if (oldPrice === newPrice && oldPrev === newPrev) return html;

  changes.push(`${ticker} price ${oldPrice} → ${newPrice}`);
  return html.replace(row, `$1${newPrice}$3${newPrev}`);
}

/**
 * Every event record in the page, as {start, end, text, d, t, c, s}.
 * Records begin with `{d:'…'` at the start of a line and run until the line
 * that closes them, so multi-line entries survive intact.
 */
function parseEvents(html) {
  const lines = html.split('\n');
  const events = [];
  let cur = null;

  lines.forEach((line, i) => {
    if (/^\{d:'\d{4}-\d{2}-\d{2}'/.test(line)) {
      if (cur) events.push(cur);
      cur = { start: i, end: i, text: line };
    } else if (cur) {
      if (/^\s/.test(line) && line.trim()) { cur.end = i; cur.text += '\n' + line; }
      else { events.push(cur); cur = null; }
    }
  });
  if (cur) events.push(cur);

  return events.map(e => ({
    ...e,
    d: e.text.match(/^\{d:'(\d{4}-\d{2}-\d{2})'/)?.[1],
    t: e.text.match(/t:'([A-Z]+)'/)?.[1],
    c: e.text.match(/c:'(\w+)'/)?.[1],
    s: e.text.match(/s:'([CES])'/)?.[1]
  })).filter(e => e.d && e.t && e.c);
}

/**
 * Rewrite one event's date and/or confidence flag, in place.
 *
 * A row already marked company-confirmed outranks an API estimate: Yahoo
 * carries a guessed date for most names, and letting a guess move a date we
 * sourced from the company's own IR page would be a downgrade, not a refresh.
 */
function reviseEvent(lines, ev, newDate, confirm, label) {
  const first = lines[ev.start];
  let updated = first;

  if (ev.s === 'C' && !confirm) {
    if (newDate && newDate !== ev.d) problems.push(`${ev.t} ${label}: kept confirmed ${ev.d}, ignored estimate ${newDate}`);
    return;
  }

  if (newDate && newDate !== ev.d) {
    updated = updated.replace(/^\{d:'\d{4}-\d{2}-\d{2}'/, `{d:'${newDate}'`);
    changes.push(`${ev.t} ${label} ${ev.d} → ${newDate}`);
  }
  if (confirm && ev.s === 'E') {
    updated = updated.replace(/s:'E'/, "s:'C'");
    changes.push(`${ev.t} ${label} estimated → confirmed`);
  }
  if (updated !== first) lines[ev.start] = updated;
}

/**
 * Pick the existing event a fresh API date belongs to: same ticker, same
 * category, nearest date within MATCH_DAYS. Returns undefined when the date
 * refers to something not on the calendar yet — we report those rather than
 * inventing a row, since a new event needs a title and a source.
 */
function matchEvent(events, ticker, category, apiDate, titleFilter) {
  const pool = events
    .filter(e => e.t === ticker && e.c === category)
    .filter(e => !titleFilter || titleFilter.test(e.text))
    .map(e => ({ e, gap: daysBetween(e.d, apiDate) }))
    .filter(x => x.gap <= MATCH_DAYS)
    .sort((a, b) => a.gap - b.gap);
  return pool[0]?.e;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const original = await readFile(PAGE, 'utf8');
let html = original;

const tickers = [...original.matchAll(/\{t:'([A-Z]+)',\s*name:/g)].map(m => m[1]);
if (!tickers.length) {
  console.error('Could not find POSITIONS — aborting without writing.');
  process.exit(1);
}
console.log(`Tickers: ${tickers.join(', ')}`);

const yahoo = await yahooFacts(tickers);
const finnhub = process.env.FINNHUB_TOKEN
  ? await finnhubFacts(tickers, process.env.FINNHUB_TOKEN)
  : {};
if (!process.env.FINNHUB_TOKEN) console.log('FINNHUB_TOKEN not set — Yahoo only.');

/* Prices first; they change every run and touch only numeric fields. */
for (const t of tickers) {
  const f = yahoo[t];
  if (f) html = updatePrice(html, t, f.price, f.prev);
}

/* Then dates. Finnhub wins on earnings when present — it reports
   company-announced dates, where Yahoo often carries an estimate. */
let lines = html.split('\n');
const events = parseEvents(html);

for (const t of tickers) {
  const y = yahoo[t] || {};
  const f = finnhub[t] || {};
  const earnDate = f.earnings || y.earnings;
  const earnConfirmed = f.earnings ? true : y.earningsConfirmed;

  if (isISO(earnDate)) {
    const ev = matchEvent(events, t, 'earnings', earnDate);
    if (ev) reviseEvent(lines, ev, earnDate, earnConfirmed, 'earnings');
    else problems.push(`${t}: earnings ${earnDate} matches no existing row`);
  }
  if (isISO(y.exDiv)) {
    const ev = matchEvent(events, t, 'dividend', y.exDiv, /[Ee]x-dividend|ex-date/);
    if (ev) reviseEvent(lines, ev, y.exDiv, true, 'ex-dividend');
  }
  if (isISO(y.payDiv)) {
    const ev = matchEvent(events, t, 'dividend', y.payDiv, /pay date/);
    if (ev) reviseEvent(lines, ev, y.payDiv, true, 'dividend pay');
  }
}
html = lines.join('\n');

/* Stamp the refresh dates only if something actually moved. */
if (changes.length) {
  html = html.replace(/(const PRICED = ')[\d-]+(')/, `$1${todayISO()}$2`)
             .replace(/(const UPDATED = ')[\d-]+(')/, `$1${todayISO()}$2`);
}

/* A parse failure would show up as a wildly different file size — refuse to
   write rather than publish a mangled calendar. */
if (Math.abs(html.length - original.length) > 2000) {
  console.error('Refusing to write: output differs from input by too much.');
  process.exit(1);
}

console.log('\n--- changes ---');
console.log(changes.length ? changes.map(c => '  ' + c).join('\n') : '  none');
if (problems.length) {
  console.log('--- notes ---');
  console.log(problems.map(p => '  ' + p).join('\n'));
}

if (DRY) { console.log('\n(dry run — nothing written)'); process.exit(0); }

if (changes.length) {
  await writeFile(PAGE, html);
  console.log(`\nWrote ${changes.length} change(s) to index.html`);
} else {
  console.log('\nNothing to write.');
}
