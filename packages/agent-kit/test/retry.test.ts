import { describe, expect, it, vi } from "vitest";
import {
	AttemptTimeoutError,
	backoffDelayMs,
	createRetryingFetch,
	DEFAULT_RETRY_POLICY,
	parseRetryAfterMs,
	type RetryEvent,
} from "../src/retry.js";

const noSleep = async (): Promise<void> => {};

function scripted(
	...steps: Array<number | Error | { status: number; headers?: Record<string, string> }>
) {
	const calls: Array<RequestInit | undefined> = [];
	const fn = vi.fn(async (_input: unknown, init?: RequestInit) => {
		calls.push(init);
		const step = steps.shift();
		if (step === undefined) throw new Error("no more scripted steps");
		if (step instanceof Error) throw step;
		const spec = typeof step === "number" ? { status: step } : step;
		return new Response(spec.status === 204 ? null : "{}", {
			status: spec.status,
			headers: spec.headers,
		});
	});
	return { fn: fn as unknown as typeof fetch, calls, mock: fn };
}

describe("createRetryingFetch", () => {
	it("defaults to 3 attempts with 1s then 2s backoff", async () => {
		const { fn, mock } = scripted(503, 503, 503);
		const events: RetryEvent[] = [];
		const f = createRetryingFetch(
			{ sleep: noSleep, random: () => 0, onRetry: (e) => events.push(e) },
			fn,
		);
		const res = await f("https://x/y", { method: "POST", body: "{}" });
		expect(res.status).toBe(503);
		expect(mock).toHaveBeenCalledTimes(3);
		expect(events.map((e) => e.delayMs)).toEqual([1000, 2000]);
		expect(events.every((e) => e.reason === "status" && e.status === 503)).toBe(true);
	});

	it("retries 408/409/429/5xx and returns the first success", async () => {
		for (const status of [408, 409, 429, 500, 502]) {
			const { fn, mock } = scripted(status, 200);
			const res = await createRetryingFetch({ sleep: noSleep }, fn)("https://x", { body: "{}" });
			expect(res.status).toBe(200);
			expect(mock).toHaveBeenCalledTimes(2);
		}
	});

	it("never retries other 4xx", async () => {
		for (const status of [400, 401, 403, 404, 422]) {
			const { fn, mock } = scripted(status);
			const res = await createRetryingFetch({ sleep: noSleep }, fn)("https://x");
			expect(res.status).toBe(status);
			expect(mock).toHaveBeenCalledTimes(1);
		}
	});

	it("retries network errors and rethrows the last one", async () => {
		const { fn, mock } = scripted(
			new TypeError("fetch failed"),
			new TypeError("fetch failed 2"),
			new TypeError("fetch failed 3"),
		);
		await expect(createRetryingFetch({ sleep: noSleep }, fn)("https://x")).rejects.toThrow(
			"fetch failed 3",
		);
		expect(mock).toHaveBeenCalledTimes(3);
	});

	it("does not retry once the caller aborted", async () => {
		const ctl = new AbortController();
		const fn = vi.fn(async () => {
			ctl.abort(new Error("deadline"));
			throw new Error("aborted by caller");
		}) as unknown as typeof fetch;
		await expect(
			createRetryingFetch({ sleep: noSleep }, fn)("https://x", { signal: ctl.signal }),
		).rejects.toThrow("aborted by caller");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("retries a per-attempt timeout and surfaces AttemptTimeoutError at the end", async () => {
		const hang = vi.fn(
			(_i: unknown, init?: RequestInit) =>
				new Promise<Response>((_res, rej) => {
					init?.signal?.addEventListener("abort", () => rej(init.signal?.reason));
				}),
		) as unknown as typeof fetch;
		const events: RetryEvent[] = [];
		const f = createRetryingFetch(
			{ sleep: noSleep, attemptTimeoutMs: 5, onRetry: (e) => events.push(e) },
			hang,
		);
		await expect(f("https://x")).rejects.toBeInstanceOf(AttemptTimeoutError);
		expect(hang).toHaveBeenCalledTimes(3);
		expect(events.map((e) => e.reason)).toEqual(["timeout", "timeout"]);
	});

	it("honours Retry-After and gives up when it exceeds the cap", async () => {
		const short = scripted({ status: 429, headers: { "retry-after": "3" } }, 200);
		const events: RetryEvent[] = [];
		await createRetryingFetch(
			{ sleep: noSleep, random: () => 0, onRetry: (e) => events.push(e) },
			short.fn,
		)("https://x");
		expect(events[0]?.delayMs).toBe(3000);

		const long = scripted({ status: 429, headers: { "retry-after": "60" } }, 200);
		const res = await createRetryingFetch({ sleep: noSleep }, long.fn)("https://x");
		expect(res.status).toBe(429);
		expect(long.mock).toHaveBeenCalledTimes(1);
	});

	it("stops when the backoff would cross the deadline or canRetry says no", async () => {
		const a = scripted(503, 200);
		const res = await createRetryingFetch(
			{ sleep: noSleep, now: () => 0, deadlineAt: () => 500, random: () => 0 },
			a.fn,
		)("https://x");
		expect(res.status).toBe(503);
		expect(a.mock).toHaveBeenCalledTimes(1);

		const b = scripted(503, 200);
		const res2 = await createRetryingFetch(
			{ sleep: noSleep, canRetry: () => false },
			b.fn,
		)("https://x");
		expect(res2.status).toBe(503);
		expect(b.mock).toHaveBeenCalledTimes(1);
	});

	it("does not retry a non-replayable streaming body", async () => {
		const { fn, mock } = scripted(503, 200);
		const body = new ReadableStream({ start: (c) => c.close() });
		const res = await createRetryingFetch({ sleep: noSleep }, fn)("https://x", {
			method: "POST",
			body,
			duplex: "half",
		} as RequestInit);
		expect(res.status).toBe(503);
		expect(mock).toHaveBeenCalledTimes(1);
	});
});

describe("caller signals and hints", () => {
	it("treats a Request's own aborted signal as a caller abort", async () => {
		const ctl = new AbortController();
		const fn = vi.fn(async () => {
			ctl.abort(new Error("deadline"));
			throw new Error("aborted");
		}) as unknown as typeof fetch;
		const req = new Request("https://x", { signal: ctl.signal });
		await expect(createRetryingFetch({ sleep: noSleep }, fn)(req)).rejects.toThrow("aborted");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("prefers retry-after-ms over retry-after", async () => {
		const s = scripted(
			{ status: 429, headers: { "retry-after-ms": "1500", "retry-after": "9" } },
			200,
		);
		const events: RetryEvent[] = [];
		await createRetryingFetch(
			{ sleep: noSleep, random: () => 0, onRetry: (e) => events.push(e) },
			s.fn,
		)("https://x");
		expect(events[0]?.delayMs).toBe(1500);
	});
});

describe("helpers", () => {
	it("parses Retry-After seconds and dates", () => {
		expect(parseRetryAfterMs("2")).toBe(2000);
		expect(parseRetryAfterMs("0.5")).toBe(500);
		expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
		expect(parseRetryAfterMs("soon")).toBeNull();
		expect(parseRetryAfterMs(null)).toBeNull();
	});

	it("caps exponential backoff and applies jitter downward", () => {
		expect([1, 2, 3, 4].map((n) => backoffDelayMs(n, DEFAULT_RETRY_POLICY, () => 0))).toEqual([
			1000, 2000, 4000, 4000,
		]);
		expect(backoffDelayMs(1, DEFAULT_RETRY_POLICY, () => 1)).toBe(800);
	});
});
