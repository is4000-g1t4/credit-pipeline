// The one OpenRouter client factory for every agent. The SDK's own retry
// loop is disabled (`maxRetries: 0`) so retries/backoff come only from
// `createRetryingFetch` and behave the same in every service.
import OpenAI from "openai";
import { createRetryingFetch, type RetryOptions } from "./retry.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterClientOptions {
	apiKey: string;
	baseURL?: string;
	/**
	 * Overall per-request timeout enforced by the SDK; it bounds every retry
	 * of that request (the SDK aborts the signal our fetch observes).
	 */
	timeoutMs?: number;
	/** Retry tuning; defaults to DEFAULT_RETRY_POLICY. `false` disables retries. */
	retry?: RetryOptions | false;
	/** Underlying fetch (tests, eval stubs). Retries wrap it. */
	fetchImpl?: typeof fetch;
}

export function createOpenRouterClient(opts: OpenRouterClientOptions): OpenAI {
	const base = opts.fetchImpl ?? fetch;
	const fetchImpl = opts.retry === false ? base : createRetryingFetch(opts.retry ?? {}, base);
	return new OpenAI({
		apiKey: opts.apiKey,
		baseURL: opts.baseURL ?? OPENROUTER_BASE_URL,
		maxRetries: 0,
		...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
		fetch: fetchImpl,
	});
}
