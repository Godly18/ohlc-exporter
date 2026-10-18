// Cooperative yielding. Every CPU-heavy loop (encode, decode, validate, CSV) calls this every
// few thousand iterations so the event loop keeps turning and GET /health is answered
// immediately even while a large export is being generated.

export const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Iterations between yields in hot loops. Tuned so each slice runs ~1 ms. */
export const YIELD_EVERY = 4096;
