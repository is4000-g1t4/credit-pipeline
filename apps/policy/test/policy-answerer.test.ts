import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RETRY_POLICY } from "@credit/agent-kit";
import { createOpenRouterAnswerer, definition } from "../src/agents/policy-answerer/index.js";
import { createOpenRouterEmbedder, type OpenRouterConfig } from "../src/openrouter.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const okChat = (): Response =>
	new Response(
		JSON.stringify({ choices: [{ message: { content: '{"status":"no_match"}' } }], usage: {} }),
		{ status: 200 },
	);

const okEmbedding = (): Response =>
	new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }], usage: {} }), {
		status: 200,
	});

const section = {
	policyKey: "POL-CR-001",
	sectionId: "4.2",
	version: "v1",
	title: "T",
	heading: "H",
	body: `${"x".repeat(7000)} é “q”`,
};

function setup(responses: Array<Response | Error>, overrides: Partial<OpenRouterConfig> = {}) {
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
	const queue = [...responses];
	const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
		calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
		const next = queue.shift();
		if (!next) throw new Error("fetch script exhausted");
		if (next instanceof Error) throw next;
		return next;
	}) as unknown as typeof fetch;
	const sleeps: number[] = [];
	const warn = vi.fn();
	const config: OpenRouterConfig = {
		apiKey: "key",
		baseUrl: "http://openrouter.test/api/v1",
		model: "m",
		dimensions: 3,
		embeddingModel: "e",
		temperature: 0,
		maxOutputTokens: 100,
		fetchImpl,
		logger: { warn },
		retry: {
			random: () => 0,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		},
		...overrides,
	};
	return {
		config,
		calls,
		fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>,
		sleeps,
		warn,
	};
}

const navigatorInput = () => ({
	question: "What is DSCR?\nline2",
	sections: [section] as never,
	signal: new AbortController().signal,
	conversationId: "c",
});

describe("policy-answerer prompts", () => {
	it("keeps the assembled prompts byte-identical to the pre-move values", async () => {
		const { config, calls } = setup([okChat(), okChat()], { answererProviderOrder: ["p1"] });
		const answerer = createOpenRouterAnswerer(config);
		await answerer.answerNavigator(navigatorInput());
		await answerer.answerCase({
			context: {
				signals: [{ ref: "signal:a" }],
				documentFindings: [{ field: "identity", index: 2, note: "n" }],
			} as never,
			sections: [section] as never,
			signal: new AbortController().signal,
			conversationId: "c",
		});
		const messages = calls.map((c) => c.body.messages as Array<{ role: string; content: string }>);
		expect(sha(messages[0]![0]!.content)).toBe(
			"e9b9801801a8d303d11504f4f7ae06a9be3aacf5b06f1f2c16cd198bdb032adf",
		);
		expect(sha(messages[1]![0]!.content)).toBe(
			"801a4af20a25f7726589188c5c32e8a6aa9e676cf82c97844be73273c3d74a8e",
		);
		expect(sha(JSON.stringify(messages[0]))).toBe(
			"bf9c1b3a870f07780e344fee896fd1dce46465532176e0f7ecb2f8d6d1b571a5",
		);
		expect(sha(JSON.stringify(messages[1]))).toBe(
			"7c235bed097ec43fcd47a790b8c531d01638392b13bcfb423effd0593e8c2533",
		);
	});

	it("declares the advisory request-scoped agent manifest", () => {
		expect(definition.name).toBe("policy-answerer");
		expect(definition.model).toEqual({
			env: "POLICY_AGENT_MODEL",
			default: "openai/gpt-6.1-terra",
		});
		expect(definition.flags).toEqual(["POLICY_ASSIST_ENABLED"]);
		expect(definition.tools).toEqual([]);
		expect(definition.execution).toBe("request");
	});
});

describe("policy OpenRouter retries (agent-kit DEFAULT_RETRY_POLICY)", () => {
	it("uses the shared 3-attempt policy", () => {
		expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(3);
	});

	it("retries 503 twice then succeeds, backing off 1s then 2s", async () => {
		const { config, fetchImpl, sleeps } = setup([
			new Response("down", { status: 503 }),
			new Response("down", { status: 503 }),
			okChat(),
		]);
		const result = await createOpenRouterAnswerer(config).answerNavigator(navigatorInput());
		expect(result.output).toEqual({ status: "no_match" });
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(sleeps).toEqual([1_000, 2_000]);
	});

	it("gives up after 3 attempts and keeps the OpenRouter <status> error mapping", async () => {
		const { config, fetchImpl } = setup([
			new Response("bad gateway one", { status: 502 }),
			new Response("bad gateway two", { status: 502 }),
			new Response("bad gateway three", { status: 502 }),
			okChat(),
		]);
		await expect(
			createOpenRouterAnswerer(config).answerNavigator(navigatorInput()),
		).rejects.toThrow("OpenRouter 502: bad gateway three");
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("does not retry other 4xx", async () => {
		const { config, fetchImpl, sleeps } = setup([new Response("nope", { status: 401 }), okChat()]);
		await expect(
			createOpenRouterAnswerer(config).answerNavigator(navigatorInput()),
		).rejects.toThrow("OpenRouter 401: nope");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(sleeps).toEqual([]);
	});

	it("retries 429 and honours Retry-After", async () => {
		const { config, fetchImpl, sleeps } = setup([
			new Response("slow down", { status: 429, headers: { "retry-after": "3" } }),
			okChat(),
		]);
		await createOpenRouterAnswerer(config).answerNavigator(navigatorInput());
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(sleeps).toEqual([3_000]);
	});

	it("retries network errors and rethrows the last one", async () => {
		const first = setup([new TypeError("fetch failed"), okChat()]);
		await createOpenRouterAnswerer(first.config).answerNavigator(navigatorInput());
		expect(first.fetchImpl).toHaveBeenCalledTimes(2);

		const failing = setup([new TypeError("a"), new TypeError("b"), new TypeError("last")]);
		await expect(
			createOpenRouterAnswerer(failing.config).answerNavigator(navigatorInput()),
		).rejects.toThrow("last");
		expect(failing.fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("stops retrying once the caller aborts", async () => {
		const controller = new AbortController();
		const { config, fetchImpl, sleeps } = setup([new Response("down", { status: 503 }), okChat()], {
			retry: {
				random: () => 0,
				sleep: async (ms, signal) => {
					void ms;
					controller.abort(new Error("deadline"));
					if (signal?.aborted) throw signal.reason;
				},
			},
		});
		void sleeps;
		await expect(
			createOpenRouterAnswerer(config).answerNavigator({
				...navigatorInput(),
				signal: controller.signal,
			}),
		).rejects.toThrow("deadline");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("logs retry metadata only", async () => {
		const { config, warn } = setup([new Response("secret-body-text", { status: 503 }), okChat()]);
		await createOpenRouterAnswerer(config).answerNavigator(navigatorInput());
		expect(warn).toHaveBeenCalledTimes(1);
		const [meta] = warn.mock.calls[0]!;
		expect(meta).toEqual({
			agent: "policy-answerer",
			attempt: 1,
			reason: "status",
			status: 503,
			delayMs: 1_000,
		});
		expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-body-text");
	});

	it("applies the same policy to embeddings", async () => {
		const { config, fetchImpl, sleeps, warn } = setup([
			new Response("down", { status: 500 }),
			new Response("down", { status: 500 }),
			okEmbedding(),
		]);
		const vectors = await createOpenRouterEmbedder(config).embed(["hello"]);
		expect(vectors).toEqual([[0.1, 0.2, 0.3]]);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(sleeps).toEqual([1_000, 2_000]);
		expect(warn.mock.calls[0]![0]).toMatchObject({ agent: "policy-embedder", attempt: 1 });
	});

	it("does not retry embedding 4xx, then falls back without provider routing", async () => {
		const { config, calls, fetchImpl } = setup(
			[new Response("no provider routing", { status: 400 }), okEmbedding()],
			{ embeddingProviders: ["p1"] },
		);
		await createOpenRouterEmbedder(config).embed(["hello"]);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(calls[0]!.body.provider).toEqual({ order: ["p1"] });
		expect(calls[1]!.body.provider).toBeUndefined();
	});

	it("falls back without provider routing on 422", async () => {
		const { config, calls } = setup(
			[new Response("bad provider", { status: 422 }), okEmbedding()],
			{ embeddingProviders: ["p1"] },
		);
		await expect(createOpenRouterEmbedder(config).embed(["hello"])).resolves.toEqual([
			[0.1, 0.2, 0.3],
		]);
		expect(calls).toHaveLength(2);
		expect(calls[1]!.body.provider).toBeUndefined();
	});

	it("does not fall back without provider routing after persistent 5xx", async () => {
		const { config, calls } = setup(
			[
				new Response("down", { status: 503 }),
				new Response("down", { status: 503 }),
				new Response("down", { status: 503 }),
				okEmbedding(),
			],
			{ embeddingProviders: ["p1"] },
		);
		await expect(createOpenRouterEmbedder(config).embed(["hello"])).rejects.toThrow(
			"OpenRouter 503",
		);
		expect(calls).toHaveLength(DEFAULT_RETRY_POLICY.maxAttempts);
		expect(calls.every((c) => c.body.provider !== undefined)).toBe(true);
	});

	it("does not fall back without provider routing on 401", async () => {
		const { config, calls } = setup(
			[new Response("unauthorized", { status: 401 }), okEmbedding()],
			{ embeddingProviders: ["p1"] },
		);
		await expect(createOpenRouterEmbedder(config).embed(["hello"])).rejects.toThrow(
			"OpenRouter 401",
		);
		expect(calls).toHaveLength(1);
	});
});
