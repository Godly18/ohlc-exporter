// Minimal structured logger with secret redaction. Secrets (OANDA token, R2 keys, DB URL,
// token secret) are scrubbed from every line even if they somehow end up in a message.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export function createLogger({ level = 'info', secrets = [], sink = null } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const redactList = secrets.filter((s) => typeof s === 'string' && s.length >= 6);

  const redact = (text) => {
    let out = text;
    for (const s of redactList) out = out.split(s).join('[redacted]');
    return out;
  };

  const emit = (lvl, message, meta) => {
    if (LEVELS[lvl] < threshold) return;
    let line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${message}`;
    if (meta !== undefined) {
      try {
        line += ` ${JSON.stringify(meta, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, code: v.code } : v))}`;
      } catch {
        line += ' [unserializable meta]';
      }
    }
    line = redact(line);
    if (sink) sink(lvl, line);
    else (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
  };

  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    redact,
  };
}

export function silentLogger() {
  return createLogger({ level: 'silent' });
}
