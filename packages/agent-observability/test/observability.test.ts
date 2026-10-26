import { afterEach, expect, it } from "vitest";
import { getObservability, resetObservability } from "../src/index.js";

afterEach(() => {
	resetObservability();
	delete process.env.OTEL_SDK_DISABLED;
	delete process.env.AGENTO11Y_ENDPOINT;
	delete process.env.AGENTO11Y_AUTH_TOKEN;
});

it("degrades to a no-op without sending or failing the run", async () => {
	process.env.OTEL_SDK_DISABLED = "true";
	const obs = getObservability("test-app");
	expect(obs.status).toBe("degraded");
	expect(
		obs.hooksFor({} as never, {
			agentName: "test",
			agentVersion: "1",
			feature: "test",
			model: "test-model",
		}),
	).toEqual({ detach: expect.any(Function) });

	let ran = false;
	const result = await obs.trackGeneration(
		{
			agentName: "test",
			agentVersion: "1",
			feature: "test",
			model: "test-model",
		},
		async () => {
			ran = true;
			return 42;
		},
	);
	expect(result).toBe(42);
	expect(ran).toBe(true);
	await obs.shutdown();
});
