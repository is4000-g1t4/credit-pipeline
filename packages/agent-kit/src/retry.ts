// Model-call retry with exponential backoff (shared by every agent).
//
// Wraps `fetch` so it works under the OpenAI SDK (`new OpenAI({ fetch })`),
// the @openai/agents runner (which uses that client), and raw fetch callers
// such as the policy service. Retries only transient failures:
//   - HTTP 408, 409, 429 and 5xx
//   - network errors (fetch rejects before a response)
//   - a per-attempt timeout (`attemptTimeoutMs`)
// Never retries: other 4xx (auth, bad request, not found), a caller abort
// (the run deadline / budget signal), or anything after the response body
// was handed back (schema or validator failures live above this layer).
//
// Retry metadata only (attempt, status, delay) reaches `onRetry`; request
// and response bodies are never read or logged here.

export interface RetryPolicy {
	/** Total attempts including the first. */
	maxAttempts: number;
	/** Delay before the first retry; doubles each retry. */
	baseDelayMs: number;
	/** Cap on the computed exponential delay. */
	maxDelayMs: number;
	/** Cap on an upstream Retry-After hint; longer hints stop retrying. */
	maxRetryAfterMs: number;
	/** Full-jitter fraction in [0, 1]: delay is scaled into [1 - jitter, 1]. */
	jitter: number;
	/** Per-attempt timeout; a timed-out attempt is retried. Unset = none. */
	attemptTimeoutMs?: number;
}

/** 3 attempts total; 1s then 2s backoff (4s cap), ±20% jitter. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
	maxAttempts: 3,
	baseDelayMs: 1_000,
	maxDelayMs: 4_000,
	maxRetryAfterMs: 10_000,
	jitter: 0.2,
});

export type RetryReason = "status" | "network" | "timeout";

export interface RetryEvent {
	/** The attempt that failed (1-based). */
	attempt: number;
	reason: RetryReason;
	status?: number;
	delayMs: number;
}

export interface RetryOptions extends Partial<RetryPolicy> {
	/** Called before each retry sleep; metadata only. */
	onRetry?: (event: RetryEvent) => void;
	/**
	 * Absolute epoch-ms deadline (e.g. the run's wall-clock budget). A retry
	 * whose backoff would land past it is not attempted.
	 */
	deadlineAt?: () => number | undefined;
	/**
	 * Extra gate checked before every retry (e.g. remaining cost budget).
	 * Returning false stops retrying and surfaces the last failure.
	 */
	canRetry?: () => boolean;
	/** Test seams. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	random?: () => number;
	now?: () => number;
}

export function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Parses Retry-After (delta-seconds or HTTP date) into ms; null if absent/invalid. */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | null {
	if (value === null) return null;
	const trimmed = value.trim();
	if (trimmed === "") return null;
	if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) return null;
	return Math.max(0, at - now);
}

/** Backoff before retry number `retry` (1-based), with jitter applied. */
export function backoffDelayMs(
	retry: number,
	policy: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs" | "jitter">,
	random: () => number = Math.random,
): number {
	const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1));
	const jitter = Math.min(1, Math.max(0, policy.jitter));
	return Math.round(exp * (1 - jitter * random()));
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Error thrown when an attempt hits `attemptTimeoutMs` on the final attempt. */
export class AttemptTimeoutError extends Error {
	override readonly name = "AttemptTimeoutError";
	constructor(readonly timeoutMs: number) {
		super(`model call attempt timed out after ${timeoutMs}ms`);
	}
}

type FetchFn = typeof fetch;

function replayable(body: unknown): boolean {
	return (
		body === undefined ||
		body === null ||
		typeof body === "string" ||
		body instanceof ArrayBuffer ||
		ArrayBuffer.isView(body) ||
		body instanceof URLSearchParams ||
		(typeof Blob !== "undefined" && body instanceof Blob)
	);
}

/**
 * Returns a fetch that retries transient failures per `options`. The
 * caller's `init.signal` is authoritative: once it aborts, the in-flight
 * attempt is cancelled and no retry is made.
 */
export function createRetryingFetch(options: RetryOptions = {}, base: FetchFn = fetch): FetchFn {
	const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...stripUndefined(options) };
	const sleep = options.sleep ?? defaultSleep;
	const random = options.random ?? Math.random;
	const now = options.now ?? Date.now;

	const retrying = async (
		input: Parameters<FetchFn>[0],
		init?: Parameters<FetchFn>[1],
	): Promise<Response> => {
		const callerSignal = init?.signal ?? undefined;
		const canReplay =
			!(input instanceof Request && input.body !== null) && replayable(init?.body ?? undefined);
		const maxAttempts = canReplay ? Math.max(1, policy.maxAttempts) : 1;

		for (let attempt = 1; ; attempt++) {
			const timeoutCtl = policy.attemptTimeoutMs !== undefined ? new AbortController() : undefined;
			const timer =
				timeoutCtl && policy.attemptTimeoutMs !== undefined
					? setTimeout(
							() => timeoutCtl.abort(new AttemptTimeoutError(policy.attemptTimeoutMs!)),
							policy.attemptTimeoutMs,
						)
					: undefined;
			const signals = [callerSignal, timeoutCtl?.signal].filter(
				(s): s is AbortSignal => s !== undefined,
			);
			const signal =
				signals.length === 0
					? undefined
					: signals.length === 1
						? signals[0]
						: AbortSignal.any(signals);
			const attemptInput = input instanceof Request ? input.clone() : input;

			let reason: RetryReason;
			let status: number | undefined;
			let retryAfterMs: number | null = null;
			let failure: unknown;
			try {
				const res = await base(attemptInput, { ...init, ...(signal ? { signal } : {}) });
				if (!isRetryableStatus(res.status) || attempt >= maxAttempts) return res;
				reason = "status";
				status = res.status;
				retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"), now());
				failure = res;
			} catch (err) {
				if (callerSignal?.aborted) throw err;
				const timedOut = timeoutCtl?.signal.aborted === true;
				if (attempt >= maxAttempts) {
					throw timedOut ? new AttemptTimeoutError(policy.attemptTimeoutMs ?? 0) : err;
				}
				reason = timedOut ? "timeout" : "network";
				failure = err;
			} finally {
				if (timer) clearTimeout(timer);
			}

			let delayMs = backoffDelayMs(attempt, policy, random);
			if (retryAfterMs !== null) {
				if (retryAfterMs > policy.maxRetryAfterMs) return giveUp(failure);
				delayMs = Math.max(delayMs, retryAfterMs);
			}
			const deadline = options.deadlineAt?.();
			if (deadline !== undefined && now() + delayMs >= deadline) return giveUp(failure);
			if (options.canRetry && !options.canRetry()) return giveUp(failure);

			// Release the failed response's connection before sleeping.
			if (failure instanceof Response) await failure.body?.cancel().catch(() => undefined);
			options.onRetry?.({ attempt, reason, ...(status !== undefined ? { status } : {}), delayMs });
			await sleep(delayMs, callerSignal);
		}
	};
	return retrying as FetchFn;
}

/** A failed Response is returned as-is (the SDK maps it); a thrown error is rethrown. */
function giveUp(failure: unknown): Response {
	if (failure instanceof Response) return failure;
	throw failure;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
