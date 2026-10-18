// Render's free tier spins a service down after ~15 minutes without inbound traffic. This pings our
// own public /health URL so the service keeps receiving traffic. /health does no work, so the ping is
// free. Failures are ignored: it must never affect the application.

export function createKeepAlive({ config, logger, fetchImpl = globalThis.fetch }) {
  let timer = null;
  return {
    start() {
      if (!config.keepAlive.enabled) return;
      const url = `${config.keepAlive.url.replace(/\/$/, '')}/health`;
      const ping = async () => {
        try {
          const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
          logger.debug('keep-alive ping', { status: res.status });
        } catch (err) {
          logger.debug('keep-alive ping failed', { error: err });
        }
      };
      timer = setInterval(ping, config.keepAlive.intervalMinutes * 60_000);
      timer.unref?.();
      logger.info('keep-alive self-ping enabled', { intervalMinutes: config.keepAlive.intervalMinutes });
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
