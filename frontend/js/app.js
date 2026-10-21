// Frontend logic. All validation here is a convenience; the server re-validates everything and is
// the only authority on date availability and on whether a download is still valid.

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
};

let pollTimer = null;
let tickTimer = null;
let deadline = 0; // performance.now() value at which the download expires (display only)
let polling = false;
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

function showStatus(kind, title, text) {
  els.status.classList.remove('hidden');
  els.title.className = `status-title ${kind}`;
  els.title.textContent = title;
  els.text.textContent = text ?? '';
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
    showStatus('warn', 'Working on it', stages[job.stage] ?? 'Processing…');
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
  setBusy(false);

  if (job.status === 'READY' && job.download) {
    showStatus('ok', 'Your ZIP is ready (contains the CSV).', `${job.request.instrument} ${job.request.timeframe}, ${job.request.startDate} to ${job.request.endDate} (UTC, inclusive)`);
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
  } else if (job.status === 'FAILED') {
    showStatus('bad', 'Could not complete the request', job.error?.message ?? 'Please try again later.');
  }
}

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
    showStatus('warn', 'Working on it', 'Starting…');
    els.bar.classList.remove('hidden');
    els.fill.classList.add('indeterminate');
    schedulePoll(job.jobId);
  } catch (err) {
    setBusy(false);
    els.bar.classList.add('hidden');
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
/** Earliest start date that still allows `end`. */
function minStartFor(end, years) {
  const [y, m, d] = end.split('-').map(Number);
  let s = ymd(new Date(Date.UTC(y - years, m - 1, d + 1)));
  while (maxEndFor(s, years) < end) s = addDaysStr(s, 1);
  return s;
}
function applyRangeLimits() {
  const latest = state.latest;
  const lowest = state.minDate || '0000-01-01';
  if (els.start.value) {
    const cap = maxEndFor(els.start.value, state.maxYears);
    els.end.max = cap < latest ? cap : latest;
    els.end.min = els.start.value > lowest ? els.start.value : lowest;
  } else {
    els.end.max = latest;
    els.end.min = lowest;
  }
  if (els.end.value) {
    const floor = minStartFor(els.end.value, state.maxYears);
    els.start.min = floor > lowest ? floor : lowest;
  } else {
    els.start.min = lowest;
  }
  els.start.max = els.end.value && els.end.value < latest ? els.end.value : latest;
}
els.start.addEventListener('change', () => {
  applyRangeLimits();
  if (els.end.value && els.end.max && els.end.value > els.end.max) els.end.value = els.end.max;
  applyRangeLimits();
});
els.end.addEventListener('change', applyRangeLimits);

/** The date pickers start at the instrument's first available year (crypto 2018, gold 2021, forex 2010). */
function applyMinYear(inst) {
  const min = `${inst.minYear}-01-01`;
  state.minDate = min;
  els.start.min = els.end.min = min;
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
