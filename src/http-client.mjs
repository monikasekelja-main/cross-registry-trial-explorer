import { setTimeout as sleep } from 'node:timers/promises';

export class SourceError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
    this.retryable = retryable;
  }
}

const transientCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
export function isTransient(error) {
  return error?.retryable === true || error?.name === 'TimeoutError' ||
    transientCodes.has(error?.code) || transientCodes.has(error?.cause?.code);
}

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  const result = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(result) ? Math.max(0, result) : 0;
}

export class JsonClient {
  constructor({ fetchImpl = fetch, intervalMs = 1000, attempts = 3, timeoutMs = 20000, maxBytes = 8_000_000 } = {}) {
    Object.assign(this, { fetchImpl, intervalMs, attempts, timeoutMs, maxBytes });
    this.nextAt = 0;
    this.queue = Promise.resolve();
    this.pending = 0;
  }

  async slot(signal) {
    if (this.pending >= 32) throw new SourceError('Source request queue is full');
    this.pending++;
    const slot = this.queue.then(async () => {
      signal?.throwIfAborted();
      await sleep(Math.max(0, this.nextAt - Date.now()), undefined, { signal });
      signal?.throwIfAborted();
      this.nextAt = Date.now() + this.intervalMs;
    });
    this.queue = slot.catch(() => {});
    slot.finally(() => { this.pending--; }).catch(() => {});
    // Race releases a cancelled caller immediately; its queued entry later skips its slot.
    await abortable(slot, signal);
  }

  async json(url, { signal, ...options } = {}) {
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      signal?.throwIfAborted();
      await this.slot(signal);
      let retryDelay = 0;
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await this.fetchImpl(url, {
          ...options, signal: requestSignal,
          headers: { Accept: 'application/json', ...options.headers },
          redirect: 'error',
        });
        if (!response.ok) {
          retryDelay = retryAfterMs(response.headers.get('retry-after'));
          await response.body?.cancel();
          throw new SourceError(`Registry returned HTTP ${response.status}`, {
            status: response.status, retryable: [429, 500, 502, 503, 504].includes(response.status),
          });
        }
        if (!response.headers.get('content-type')?.toLowerCase().includes('json')) {
          await response.body?.cancel();
          throw new SourceError('Registry returned non-JSON content; refusing to import it');
        }
        let size = 0;
        const chunks = [];
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > this.maxBytes) throw new SourceError('Registry response exceeded size limit');
          chunks.push(Buffer.from(chunk));
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new SourceError('Registry returned malformed JSON'); }
      } catch (error) {
        signal?.throwIfAborted();
        if (!isTransient(error) || attempt + 1 === this.attempts) throw error;
        const delay = Math.max(retryDelay, 1000 * 2 ** attempt * (0.75 + Math.random() / 2));
        await sleep(delay, undefined, { signal });
      }
    }
  }
}

function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
