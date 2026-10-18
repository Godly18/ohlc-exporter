// Frontend logic. All validation here is a convenience; the server re-validates everything and is
// the only authority on date availability and on whether a download is still valid.

const $ = (id) => document.getElementById(id);
const els = {
  form: $('export-form'),
  instrument: $('instrument'),
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
    DOWNLOADING: job.progress?.label ?? 'Downloading missing days from OANDA…',
    GENERATING: 'Generating your CSV…',
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
    showStatus('ok', 'Your CSV is ready.', `${job.request.instrument} ${job.request.timeframe}, ${job.request.startDate} to ${job.request.endDate} (UTC, inclusive)`);
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

async function init() {
  try {
    const cfg = await api('/api/config');
    for (const code of cfg.instruments) els.instrument.add(new Option(code.replace('_', '/'), code));
    for (const code of cfg.timeframes) els.timeframe.add(new Option(code, code));
    els.start.min = els.end.min = `${cfg.minDataYear}-01-01`;
    els.start.max = els.end.max = cfg.latestSelectableDate; // yesterday (UTC): today is never available
    els.hint.textContent = `Latest selectable date: ${cfg.latestSelectableDate} (UTC). Up to ${cfg.maxExportDays} days per request. Downloads stay valid for ${cfg.exportExpirationMinutes} minutes.`;
  } catch {
    els.hint.textContent = 'Could not load settings. Please refresh the page.';
    els.hint.classList.add('error');
    return;
  }
  await refreshActive(); // recover an in-progress or still-valid export after a refresh
}

init();
