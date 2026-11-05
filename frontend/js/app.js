// Frontend logic. All validation here is a convenience; the server re-validates everything and is
// the only authority on date availability and on whether a download is still valid.

import { attachDatePicker } from './datepicker.js';

const $ = (id) => document.getElementById(id);
const els = {
  form: $('export-form'),
  instrument: $('instrument'),
  search: $('instrument-search'),
  list: $('instrument-list'),
  timeframe: $('timeframe'),
  start: $('start'),
  end: $('end'),
  submit: $('submit'),
  hint: $('hint'),
  status: $('status'),
  title: $('status-title'),
  text: $('status-text'),
  bar: $('bar'),
  fill: $('bar-fill'),
  download: $('download'),
  link: $('download-link'),
  meta: $('download-meta'),
  countdown: $('countdown'),
  cancel: $('cancel'),
  eta: $('eta'),
};

let pollTimer = null;
let tickTimer = null;
let deadline = 0; // performance.now() value at which the download expires (display only)
let polling = false;
let currentJobId = null;
const state = { latest: '', maxYears: 2, expiry: 5, minDate: '' };

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const err = new Error(body?.error?.message ?? 'The request failed. Please try again.');
    err.code = body?.error?.code;
    throw err;
  }
  return body;
}

function showStatus(kind, title, text, { wait = false, alert = '' } = {}) {
  els.status.classList.remove('hidden');
  els.title.className = `status-title ${kind}`;
  els.title.textContent = title;
  els.text.textContent = text ?? '';
  if (alert) {
    // urgent instruction: bold, capitals, red
    const a = document.createElement('strong');
    a.className = 'alert';
    a.textContent = alert;
    els.text.append(' ', a);
  }
  if (wait) {
    const w = document.createElement('strong');
    w.className = 'wait';
    w.textContent = 'WAIT!';
    els.text.append(' ', w);
  }
}

// ---- Estimated time to finish the data retrieval (shown bottom-right while days are being downloaded) ----
// Progress from the server is "days downloaded in the current year"; the rate is measured over a sliding window of
// recent polls and carried over from one year to the next. Years after the current one are counted as full years
// (the current UTC year only up to yesterday); if one is already stored the estimate simply drops when it is reached.
const ETA_WINDOW_MS = 90_000;
const ETA_MIN_SPAN_MS = 4_000;
let eta = null;

function resetEta() {
  eta = null;
  els.eta.classList.add('hidden');
  els.eta.textContent = '';
}

function daysInYear(year) {
  const todayYear = state.latest ? Number(state.latest.slice(0, 4)) : null;
  if (todayYear === year) {
    const start = Date.UTC(year, 0, 1);
    const [y, m, d] = state.latest.split('-').map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - start) / 86_400_000) + 1;
  }
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

function formatEta(seconds) {
  const s = Math.max(5, Math.ceil(seconds / 5) * 5); // steady, 5-second steps
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} sec`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

function updateEta(job) {
  const p = job.progress;
  const year = Number(/^(\d{4}):/.exec(p?.label ?? '')?.[1]);
  if (job.stage !== 'DOWNLOADING' || !p?.total || !year) return resetEta();

  const now = performance.now();
  if (!eta || eta.jobId !== job.jobId) eta = { jobId: job.jobId, year, total: p.total, base: 0, samples: [] };
  if (year !== eta.year) {
    eta.base += eta.total; // the previous year finished
    eta.year = year;
    eta.total = p.total;
  }
  const cumulative = eta.base + p.current;
  const last = eta.samples[eta.samples.length - 1];
  if (!last || cumulative > last.done) eta.samples.push({ t: now, done: cumulative });
  while (eta.samples.length > 2 && now - eta.samples[0].t > ETA_WINDOW_MS) eta.samples.shift();

  els.eta.classList.remove('hidden');
  const first = eta.samples[0];
  const newest = eta.samples[eta.samples.length - 1];
  const span = newest.t - first.t;
  if (eta.samples.length < 2 || span < ETA_MIN_SPAN_MS) {
    els.eta.textContent = 'Estimating time left…';
    return;
  }
  const rate = (newest.done - first.done) / (span / 1000); // days per second
  const { endDate } = job.request;
  let remainingDays = Math.max(0, p.total - p.current);
  for (let y = year + 1; y <= Number(endDate.slice(0, 4)); y++) remainingDays += daysInYear(y);
  els.eta.textContent = rate > 0 ? `Est. time left: ~${formatEta(remainingDays / rate)}` : 'Estimating time left…';
}

function setBusy(busy) {
  els.submit.disabled = busy;
  els.form.setAttribute('aria-busy', String(busy));
}

function hideDownload() {
  els.download.classList.add('hidden');
  clearInterval(tickTimer);
}

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function renderCountdown() {
  const left = Math.max(0, Math.round((deadline - performance.now()) / 1000));
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  els.countdown.textContent = `${mm}:${ss}`;
  if (left === 0) {
    clearInterval(tickTimer);
    refreshActive(); // ask the server: it decides whether the export is really expired
  }
}

function renderJob(job) {
  const stages = {
    STARTING: 'Starting…',
    DATASETS: job.progress?.label ?? 'Preparing historical data…',
    DOWNLOADING: job.progress?.label ?? 'Downloading missing days…',
    GENERATING: job.progress?.label ?? 'Generating your CSV…',
  };

  if (job.status === 'PROCESSING' || job.status === 'GENERATING') {
    hideDownload();
    currentJobId = job.jobId;
    // Three phases of the message:
    //  1. preparing (STARTING / DATASETS, before any day is downloaded): label + a bold "WAIT!"
    //  2. downloading: the day being retrieved + the "you can leave and come back" note; the estimate shows bottom-right
    //  3. generating: the user must stay on the page
    const generating = job.status === 'GENERATING' || job.stage === 'GENERATING';
    const downloading = !generating && job.stage === 'DOWNLOADING';
    const label = stages[job.stage] ?? 'Processing…';
    if (generating) {
      showStatus('warn', 'Working on it', label, { alert: 'do not leave this page, wait and download your data!' });
    } else if (downloading) {
      showStatus('warn', 'Working on it', `${label} data generation might take a while, you can wait and download data or leave this page and comeback later.`);
    } else {
      showStatus('warn', 'Working on it', label, { wait: true });
    }
    if (downloading) updateEta(job);
    else resetEta();
    els.cancel.classList.remove('hidden');
    els.cancel.disabled = false;
    els.cancel.textContent = 'Cancel';
    els.bar.classList.remove('hidden');
    if (job.progress?.total) {
      els.fill.classList.remove('indeterminate');
      els.fill.style.width = `${Math.min(100, Math.round((job.progress.current / job.progress.total) * 100))}%`;
    } else {
      els.fill.classList.add('indeterminate');
      els.fill.style.width = '';
    }
    setBusy(true);
    schedulePoll(job.jobId);
    return;
  }

  els.bar.classList.add('hidden');
  resetEta();
  setBusy(false);
  // A READY export can still be cancelled (it deletes the file); every other end state has nothing to cancel.
  currentJobId = job.jobId;
  els.cancel.classList.toggle('hidden', job.status !== 'READY');
  els.cancel.disabled = false;
  els.cancel.textContent = 'Cancel download';

  if (job.status === 'READY' && job.download) {
    showStatus('ok', 'Your ZIP is ready (contains the CSV).', `${job.request.instrument} ${job.request.timeframe}, ${job.request.startDate} to ${job.request.endDate} (UTC, inclusive).`, { alert: 'Do not leave this page, wait and download your data!' });
    els.link.href = job.download.url;
    els.link.setAttribute('download', job.download.filename);
    els.meta.textContent = `${job.download.rows.toLocaleString()} rows · ${formatBytes(job.download.fileSize)}`;
    deadline = performance.now() + job.download.expiresInSeconds * 1000;
    els.download.classList.remove('hidden');
    clearInterval(tickTimer);
    renderCountdown();
    tickTimer = setInterval(renderCountdown, 1000);
    return;
  }

  hideDownload();
  if (job.status === 'EXPIRED') {
    showStatus('warn', 'Download expired', job.error?.message ?? 'This download has expired. Please generate the data again.');
  } else if (job.status === 'CANCELLED') {
    showStatus('warn', 'Cancelled', 'The request was cancelled. Data already retrieved stays saved on the server, so a new request will continue from there.');
  } else if (job.status === 'FAILED') {
    const kept = job.error?.code === 'DATA_NOT_AVAILABLE_YET' ? ' Whatever was retrieved so far is saved on the server and will be continued automatically.' : '';
    showStatus('bad', 'Could not complete the request', `${job.error?.message ?? 'Please try again later.'}${kept}`);
  }
}

els.cancel.addEventListener('click', async () => {
  if (!currentJobId) return;
  els.cancel.disabled = true;
  els.cancel.textContent = 'Cancelling…';
  clearTimeout(pollTimer);
  try {
    await api(`/api/export/cancel/${encodeURIComponent(currentJobId)}`, { method: 'POST' });
    // the server finishes cancelling in the background (it may take a moment to stop the retrieval)
    for (let i = 0; i < 20; i++) {
      const job = await api(`/api/export/status/${encodeURIComponent(currentJobId)}`);
      if (job.status !== 'PROCESSING' && job.status !== 'GENERATING') return renderJob(job);
      await new Promise((r) => setTimeout(r, 500));
    }
    refreshActive();
  } catch (err) {
    els.cancel.disabled = false;
    els.cancel.textContent = 'Cancel';
    showStatus('bad', 'Could not cancel', err.message);
  }
});

function schedulePoll(jobId) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (polling) return;
    polling = true;
    try {
      renderJob(await api(`/api/export/status/${encodeURIComponent(jobId)}`));
    } catch (err) {
      showStatus('bad', 'Connection problem', `${err.message} Retrying…`);
      schedulePoll(jobId);
    } finally {
      polling = false;
    }
  }, 2000);
}

async function refreshActive() {
  try {
    const { active } = await api('/api/export/active');
    if (active) renderJob(active);
  } catch {
    /* the service may still be starting; the user can simply submit again */
  }
}

function clientCheck() {
  const { value: start } = els.start;
  const { value: end } = els.end;
  if (!start || !end) return 'Please choose a start and an end date.';
  if (start > end) return 'Invalid date range. The start date must not be later than the end date.';
  if (end > state.latest) return `The last selectable day is ${state.latest} (UTC). Today is never available.`;
  if (end > maxEndFor(start, state.maxYears)) return `Please request at most ${state.maxYears} years at a time.`;
  return null;
}

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.hint.textContent = '';
  els.hint.classList.remove('error');
  const problem = clientCheck();
  if (problem) {
    els.hint.textContent = problem;
    els.hint.classList.add('error');
    return;
  }
  setBusy(true);
  hideDownload();
  try {
    const job = await api('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instrument: els.instrument.value,
        timeframe: els.timeframe.value,
        start_date: els.start.value,
        end_date: els.end.value,
      }),
    });
    resetEta();
    showStatus('warn', 'Working on it', 'Starting…', { wait: true });
    els.bar.classList.remove('hidden');
    els.fill.classList.add('indeterminate');
    schedulePoll(job.jobId);
  } catch (err) {
    setBusy(false);
    els.bar.classList.add('hidden');
    resetEta();
    const kind = err.code === 'SYSTEM_BUSY' || err.code === 'DATA_NOT_AVAILABLE_YET' ? 'warn' : 'bad';
    showStatus(kind, err.code === 'SYSTEM_BUSY' ? 'System busy' : 'Request not accepted', err.message);
  }
});

// ---- Searchable instrument picker (type to filter, arrow keys / click to choose, list scrolls) ----
// Each instrument knows its group (Forex / Crypto / Metals) and the first year it can be requested.
const combo = { all: [], byCode: new Map(), shown: [], active: -1 };
const labelOf = (code) => combo.byCode.get(code)?.label ?? code;
const GROUP_WORDS = { Forex: 'forex fx currency', Crypto: 'crypto cryptocurrency coin', Metals: 'metal metals gold xau' };
const norm = (t) => t.toLowerCase().replace(/[\/_\s-]/g, '');

function comboOpen(open) {
  els.list.classList.toggle('hidden', !open);
  els.search.setAttribute('aria-expanded', String(open));
}

function comboRender(showAll = false) {
  const q = showAll ? '' : norm(els.search.value.trim());
  combo.shown = combo.all.filter((i) => !q || norm(`${i.code} ${i.label} ${i.group} ${GROUP_WORDS[i.group] ?? ''}`).includes(q));
  els.list.textContent = '';
  if (!combo.shown.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No matching instrument';
    els.list.append(li);
    combo.active = -1;
    return;
  }
  combo.shown.forEach((inst, i) => {
    const li = document.createElement('li');
    li.id = `inst-${inst.code}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(inst.code === els.instrument.value));
    li.dataset.code = inst.code;
    const name = document.createElement('span');
    name.textContent = inst.label;
    const tag = document.createElement('small');
    tag.className = 'tag';
    tag.textContent = inst.group;
    li.append(name, tag);
    els.list.append(li);
    if (inst.code === els.instrument.value && combo.active < 0) combo.active = i;
  });
  comboActivate(combo.active >= 0 && combo.active < combo.shown.length ? combo.active : 0);
}

function comboActivate(i) {
  els.list.querySelector('.active')?.classList.remove('active');
  combo.active = i;
  const li = els.list.children[i];
  if (!li || li.classList.contains('empty')) return;
  li.classList.add('active');
  els.search.setAttribute('aria-activedescendant', li.id);
  li.scrollIntoView({ block: 'nearest' });
}

// ---- Range limits in the calendar: at most `maxYears` years per request, never later than yesterday (UTC) ----
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
function addDaysStr(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return ymd(new Date(Date.UTC(y, m - 1, d + n)));
}
/** Last allowed end date for a start date: the day before its `years`-th anniversary (matches the server). */
function maxEndFor(start, years) {
  const [y, m, d] = start.split('-').map(Number);
  const anniversary = new Date(Date.UTC(y + years, m - 1, d));
  if (anniversary.getUTCMonth() !== m - 1) anniversary.setUTCDate(0);
  return ymd(new Date(anniversary.getTime() - 86_400_000));
}
/**
 * Calendar limits. Start: first year of the instrument .. yesterday. End: from the chosen start, at most `maxYears`
 * years later and never after yesterday. Days outside these limits are disabled in the picker (datepicker.js).
 */
function applyRangeLimits() {
  const lowest = state.minDate || '0000-01-01';
  els.start.min = lowest;
  els.start.max = state.latest;
  if (els.start.value) {
    const cap = maxEndFor(els.start.value, state.maxYears);
    els.end.min = els.start.value > lowest ? els.start.value : lowest;
    els.end.max = cap < state.latest ? cap : state.latest;
  } else {
    els.end.min = lowest;
    els.end.max = state.latest;
  }
}
els.start.addEventListener('change', () => {
  if (els.start.value && els.end.value) {
    const cap = maxEndFor(els.start.value, state.maxYears);
    if (els.end.value < els.start.value) els.end.value = '';
    else if (els.end.value > cap) els.end.value = cap < state.latest ? cap : state.latest;
  }
  applyRangeLimits();
});
els.end.addEventListener('change', applyRangeLimits);
attachDatePicker(els.start);
attachDatePicker(els.end);

/** The date pickers start at the instrument's first available year (crypto 2018, gold 2021, forex 2010). */
function applyMinYear(inst) {
  const min = `${inst.minYear}-01-01`;
  state.minDate = min;
  for (const input of [els.start, els.end]) {
    if (input.value && input.value < min) input.value = min <= (input.max || min) ? min : '';
  }
  applyRangeLimits();
  els.hint.classList.remove('error');
  els.hint.textContent = `${inst.label}: data from ${inst.minYear} to ${state.latest} (UTC). Up to ${state.maxYears} years per request. Downloads stay valid for ${state.expiry} minutes.`;
}

function comboChoose(code) {
  const inst = combo.byCode.get(code);
  if (!inst) return;
  els.instrument.value = code;
  els.search.value = inst.label;
  comboOpen(false);
  applyMinYear(inst);
}

function comboRestore() {
  // Leaving the box without a valid choice puts the last valid selection back.
  els.search.value = els.instrument.value ? labelOf(els.instrument.value) : '';
  comboOpen(false);
}

els.search.addEventListener('focus', () => {
  els.search.select();
  combo.active = -1;
  comboRender(true); // show every instrument first; typing then filters
  comboOpen(true);
});
els.search.addEventListener('input', () => {
  combo.active = -1;
  comboRender();
  comboOpen(true);
});
els.search.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (els.list.classList.contains('hidden')) {
      comboRender(true);
      comboOpen(true);
      return;
    }
    const n = combo.shown.length;
    if (n) comboActivate((combo.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
  } else if (e.key === 'Enter') {
    if (!els.list.classList.contains('hidden') && combo.shown[combo.active]) {
      e.preventDefault();
      comboChoose(combo.shown[combo.active].code);
    }
  } else if (e.key === 'Escape') {
    comboRestore();
  }
});
els.search.addEventListener('blur', () => setTimeout(comboRestore, 120)); // after a click on an option registers
els.list.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-code]');
  if (li) {
    e.preventDefault();
    comboChoose(li.dataset.code);
  }
});

async function init() {
  try {
    const cfg = await api('/api/config');
    combo.all = cfg.instruments;
    combo.byCode = new Map(cfg.instruments.map((i) => [i.code, i]));
    for (const code of cfg.timeframes) els.timeframe.add(new Option(code, code));
    state.latest = cfg.latestSelectableDate;
    state.maxYears = cfg.maxExportYears;
    state.expiry = cfg.exportExpirationMinutes;
    els.start.max = els.end.max = cfg.latestSelectableDate; // yesterday (UTC): today is never available, for both calendars
    comboChoose(combo.byCode.has('EUR_USD') ? 'EUR_USD' : combo.all[0].code);
  } catch {
    els.hint.textContent = 'Could not load settings. Please refresh the page.';
    els.hint.classList.add('error');
    return;
  }
  await refreshActive(); // recover an in-progress or still-valid export after a refresh
}

init();
