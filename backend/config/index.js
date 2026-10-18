// Environment parsing. Never throws: the HTTP server (and /health) must come up even when
// configuration is incomplete. Missing required variables are reported in `missing`.

export function loadConfig(env = process.env) {
  const str = (key, fallback = '') => {
    const v = env[key];
    return v === undefined || v === null ? fallback : String(v).trim();
  };
  const int = (key, fallback) => {
    const raw = str(key, '');
    if (raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  };
  const bool = (key, fallback) => {
    const raw = str(key, '').toLowerCase();
    if (raw === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(raw);
  };

  const nodeEnv = str('NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';
  const oandaEnvironment = str('OANDA_ENVIRONMENT', 'practice').toLowerCase() === 'live' ? 'live' : 'practice';
  const renderUrl = str('RENDER_EXTERNAL_URL', '');

  const config = {
    nodeEnv,
    isProduction,
    port: int('PORT', 10000),
    host: '0.0.0.0',
    forceHttps: bool('FORCE_HTTPS', isProduction),
    trustProxyHops: Math.max(0, int('TRUST_PROXY_HOPS', 1)),

    databaseUrl: str('DATABASE_URL'),
    databaseSsl: bool('DATABASE_SSL', false),

    oanda: {
      token: str('OANDA_API_TOKEN'),
      environment: oandaEnvironment,
      host: oandaEnvironment === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com',
      timeoutMs: int('OANDA_TIMEOUT_MS', 30_000),
      maxRetries: Math.max(0, int('OANDA_MAX_RETRIES', 3)),
      requestDelayMs: Math.max(0, int('OANDA_REQUEST_DELAY_MS', 250)),
    },

    r2: {
      accountId: str('R2_ACCOUNT_ID'),
      accessKeyId: str('R2_ACCESS_KEY_ID'),
      secretAccessKey: str('R2_SECRET_ACCESS_KEY'),
      bucket: str('R2_BUCKET_NAME'),
      endpoint: str('R2_ENDPOINT'), // optional override (e.g. a local S3 server)
    },

    exportTokenSecret: str('EXPORT_TOKEN_SECRET'),
    exportExpirationMinutes: Math.max(1, int('EXPORT_EXPIRATION_MINUTES', 5)),
    cleanupIntervalSeconds: Math.max(5, int('CLEANUP_INTERVAL_SECONDS', 60)),
    maxExportDays: Math.max(1, int('MAX_EXPORT_DAYS', 800)),

    lockLeaseSeconds: Math.max(10, int('LOCK_LEASE_SECONDS', 90)),
    lockHeartbeatSeconds: Math.max(1, int('LOCK_HEARTBEAT_SECONDS', 15)),

    daySettleMinutes: Math.max(0, int('DAY_SETTLE_MINUTES', 10)),
    minDataYear: int('MIN_DATA_YEAR', 2010),
    checkpointDays: Math.max(1, int('CHECKPOINT_DAYS', 30)),
    extraClosedDates: new Set(
      str('EXTRA_CLOSED_DATES')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

    maintenance: {
      enabled: bool('MAINTENANCE_ENABLED', true),
      intervalMinutes: Math.max(1, int('MAINTENANCE_INTERVAL_MINUTES', 60)),
      startDelaySeconds: Math.max(0, int('MAINTENANCE_START_DELAY_SECONDS', 120)),
    },

    keepAlive: {
      enabled: bool('KEEP_ALIVE_ENABLED', true) && renderUrl !== '',
      url: renderUrl,
      intervalMinutes: Math.max(1, int('KEEP_ALIVE_INTERVAL_MINUTES', 10)),
    },

    rateLimit: {
      windowMs: 60_000,
      apiPerWindow: Math.max(1, int('RATE_LIMIT_API_PER_MIN', 300)),
      exportPerWindow: Math.max(1, int('RATE_LIMIT_EXPORT_PER_MIN', 20)),
    },
  };

  const missing = [];
  const need = (name, value) => {
    if (!value) missing.push(name);
  };
  need('DATABASE_URL', config.databaseUrl);
  need('OANDA_API_TOKEN', config.oanda.token);
  need('R2_ACCOUNT_ID', config.r2.accountId);
  need('R2_ACCESS_KEY_ID', config.r2.accessKeyId);
  need('R2_SECRET_ACCESS_KEY', config.r2.secretAccessKey);
  need('R2_BUCKET_NAME', config.r2.bucket);
  if (config.exportTokenSecret.length < 16) missing.push('EXPORT_TOKEN_SECRET (min 16 chars)');

  return { config, missing };
}

/** Every secret value in the config, so the logger can redact them wherever they might appear. */
export function secretValues(config) {
  return [
    config.oanda?.token,
    config.r2?.secretAccessKey,
    config.r2?.accessKeyId,
    config.exportTokenSecret,
    config.databaseUrl,
  ].filter((v) => typeof v === 'string' && v.length >= 6);
}
