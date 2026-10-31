// Tavily HTTP rides agent-kit's retrying fetch: transient failures retry,
// the existing error mapping sees only the final outcome, and the per-call
// abort signal still bounds every attempt.
import type { RetryEvent } from "@credit/agent-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTavilyClient, TavilyError } from "../../src/agents/case-brief/index.js";

const ok = (): Response =>
	new Response(JSON.stringify({ results: [{ url: "https://a.example/x", title: "T" }] }), {
		status: 200,
	});

function client(responses: Array<() => Response | Promise<Response>>, timeoutMs?: number) {
	const calls: number[] = [];
	const events: RetryEvent[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			calls.push(1);
			const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
			return next();
		}),
	);
	const tavily = createTavilyClient({
		apiKey: "k",
		timeoutMs,
		retry: { sleep: async () => undefined, onRetry: (e) => events.push(e) },
	});
	return { tavily, calls, events };
}

const search = (t: ReturnType<typeof client>["tavily"]) =>
	t.search("q", { maxResults: 3, endDate: "2026-10-30" });

afterEach(() => vi.unstubAllGlobals());

describe("tavily retries", () => {
	it("retries a 503 once and returns the later success", async () => {
		const { tavily, calls, events } = client([() => new Response("down", { status: 503 }), ok]);
		const hits = await search(tavily);
		expect(hits.map((h) => h.url)).toEqual(["https://a.example/x"]);
		expect(calls).toHaveLength(2);
		expect(events).toEqual([
			expect.objectContaining({ attempt: 1, reason: "status", status: 503 }),
		]);
	});

	it("maps the final status after the attempts are exhausted", async () => {
		const { tavily, calls } = client([() => new Response("busy", { status: 429 })]);
		await expect(search(tavily)).rejects.toThrow(new TavilyError("tavily request failed (429)"));
		expect(calls).toHaveLength(3);
	});

	it("does not retry a 4xx", async () => {
		const { tavily, calls, events } = client([() => new Response("no", { status: 401 })]);
		await expect(search(tavily)).rejects.toThrow("tavily request failed (401)");
		expect(calls).toHaveLength(1);
		expect(events).toHaveLength(0);
	});

	it("retries network errors, then reports the existing generic failure", async () => {
		const { tavily, calls } = client([
			() => {
				throw new TypeError("fetch failed");
			},
		]);
		await expect(search(tavily)).rejects.toThrow("tavily request failed");
		expect(calls).toHaveLength(3);
	});

	it("stops at the per-call deadline instead of retrying", async () => {
		const { tavily, calls, events } = client(
			[
				(): Promise<Response> =>
					new Promise((_resolve, reject) => {
						// Never answers; only the caller's abort signal ends it.
						setTimeout(() => reject(new DOMException("aborted", "AbortError")), 50);
					}),
			],
			10,
		);
		await expect(search(tavily)).rejects.toThrow("tavily request failed");
		expect(calls).toHaveLength(1);
		expect(events).toHaveLength(0);
	});
});
