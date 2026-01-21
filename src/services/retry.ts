// src/services/retry.ts

export type RetryOptions = {
  attempts?: number;          // default 5
  baseMs?: number;            // default 1000
  maxMs?: number;             // default 8000
  jitter?: boolean;           // default true
  onRetry?: (err: unknown, attempt: number) => void;
};

export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const attempts = opts?.attempts ?? 5;
  const baseMs = opts?.baseMs ?? 1000;
  const maxMs = opts?.maxMs ?? 8000;
  const jitter = opts?.jitter ?? true;

  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      opts?.onRetry?.(err, attempt);

      if (attempt === attempts) break;

      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delay = jitter ? Math.floor(backoff * (0.5 + Math.random() * 0.5)) : backoff;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
