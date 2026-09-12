// The repo has no HTTP client and no shared fetch wrapper — every existing
// `fetch` call is a one-off against loopback (WDA, Appium). Outbound calls to
// Apify are the first traffic that leaves the host, so timeout, retry, and
// response-size policy live here rather than being re-invented per call site.

export interface HttpOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    retries?: number;
    signal?: AbortSignal;
}

export class HttpError extends Error {
    constructor(readonly status: number, readonly url: string, readonly body: string) {
        super(`${status} from ${url}: ${body.slice(0, 400)}`);
    }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRIES = 2;

function retryable(error: unknown): boolean {
    // 408/429 and 5xx are transient; 4xx otherwise means the request is wrong
    // and repeating it just burns Apify quota.
    if (error instanceof HttpError) return error.status === 408 || error.status === 429 || error.status >= 500;
    return true;
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Aborted')); }, { once: true });
});

export async function httpRequest(url: string, options: HttpOptions = {}): Promise<string> {
    const { method = 'GET', headers, body, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, signal } = options;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (attempt > 0) await wait(Math.min(1_000 * 2 ** (attempt - 1), 8_000), signal);
        try {
            const timeout = AbortSignal.timeout(timeoutMs);
            const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
            const response = await fetch(url, { method, headers, body, signal: composed });
            const text = await response.text();
            if (!response.ok) throw new HttpError(response.status, url, text);
            return text;
        } catch (error) {
            lastError = error;
            if (signal?.aborted || !retryable(error)) throw error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function httpJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
    const text = await httpRequest(url, { ...options, headers: { accept: 'application/json', ...options.headers } });
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new Error(`Expected JSON from ${url} but got: ${text.slice(0, 200)}`);
    }
}
