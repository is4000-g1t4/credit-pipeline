import { describe, expect, it, vi } from "vitest";
import { createOpenRouterClient } from "../src/openrouter.js";

describe("createOpenRouterClient", () => {
	it("retries a 503 from OpenRouter through the SDK", async () => {
		let n = 0;
		const fetchImpl = vi.fn(async () => {
			n += 1;
			if (n === 1) return new Response("{}", { status: 503 });
			return new Response(
				JSON.stringify({
					id: "c",
					object: "chat.completion",
					created: 0,
					model: "m",
					choices: [
						{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const client = createOpenRouterClient({
			apiKey: "k",
			fetchImpl,
			retry: { sleep: async () => {} },
		});
		const out = await client.chat.completions.create({
			model: "m",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(out.choices[0]?.message.content).toBe("ok");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("surfaces a 401 without retrying", async () => {
		const fetchImpl = vi.fn(
			async () => new Response('{"error":{"message":"no"}}', { status: 401 }),
		) as unknown as typeof fetch;
		const client = createOpenRouterClient({
			apiKey: "k",
			fetchImpl,
			retry: { sleep: async () => {} },
		});
		await expect(
			client.chat.completions.create({ model: "m", messages: [] }),
		).rejects.toMatchObject({ status: 401 });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
