export interface PosterHttpClient {
    get<T>(path: string, timeoutMs?: number): Promise<T>;
    post<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T>;
}

export function farmBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
    return (env.PHONE_FARM_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
}

export function createPosterHttpClient(baseUrl = farmBaseUrl()): PosterHttpClient {
    const request = async <T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const hasJsonBody = body !== undefined || !['GET', 'HEAD'].includes(method);
        try {
            const response = await fetch(`${baseUrl}${path}`, {
                method,
                headers: hasJsonBody
                    ? { 'content-type': 'application/json', origin: baseUrl }
                    : { origin: baseUrl },
                // Fastify rejects Content-Type: application/json with an empty body.
                body: hasJsonBody ? JSON.stringify(body ?? {}) : undefined,
                signal: controller.signal,
            });
            const text = await response.text();
            let parsed: unknown;
            try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
            if (!response.ok) {
                const error = typeof parsed === 'object' && parsed && 'error' in parsed
                    ? String((parsed as { error: unknown }).error) : text;
                throw new Error(`${method} ${path} -> ${response.status}: ${error}`);
            }
            return parsed as T;
        } finally {
            clearTimeout(timer);
        }
    };
    return {
        get: (path, timeoutMs) => request('GET', path, undefined, timeoutMs),
        post: (path, body, timeoutMs) => request('POST', path, body, timeoutMs ?? 20_000),
    };
}

export interface WorkflowSummary {
    id: string;
    name: string;
    deviceUdid?: string | null;
}

export interface WorkflowRunStatus {
    id?: string;
    status: string;
    error?: string | null;
}

export function findWorkflowByName(workflows: readonly WorkflowSummary[], name: string): WorkflowSummary | undefined {
    const matches = workflows.filter((workflow) => workflow.name === name);
    return matches[matches.length - 1];
}

export async function waitForRun(
    client: PosterHttpClient,
    runId: string,
    maxWaitMs = 8 * 60_000,
    pollMs = 5_000,
    now: () => number = Date.now,
    wait: (ms: number) => Promise<void> = delay,
): Promise<WorkflowRunStatus> {
    const deadline = now() + maxWaitMs;
    let last: WorkflowRunStatus = { status: 'pending' };
    while (now() < deadline) {
        try {
            last = await client.get<WorkflowRunStatus>(`/api/workflow-runs/${runId}`, 10_000);
            if (['succeeded', 'failed', 'stopped'].includes(last.status)) return last;
        } catch (error) {
            console.log(`[poster] poll ${runId} failed (retrying): ${error instanceof Error ? error.message : error}`);
        }
        await wait(pollMs);
    }
    return { ...last, status: 'timeout', error: last.error ?? `Timed out waiting for run ${runId}` };
}

export async function waitForFarm(client: PosterHttpClient, wait: (ms: number) => Promise<void> = delay): Promise<void> {
    for (;;) {
        try {
            await client.get('/api/workflows', 5_000);
            return;
        } catch (error) {
            console.log(`[poster] waiting for farm: ${error instanceof Error ? error.message : error}`);
            await wait(2_000);
        }
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
