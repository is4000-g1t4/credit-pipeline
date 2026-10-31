// policy-exception: manifest, prompt byte-equality, and model-call retries.
// No DB, no network. Hashes were captured before the prompts moved into
// instructions.md / memo-mode.md.
import { describe, expect, it } from "vitest";
import {
	createAgentsPolicyExceptionRunner,
	definition,
} from "../../src/agents/policy-exception/index.js";
import {
	completion,
	errorResponse,
	evidence,
	messageHashes,
	policyContext,
	policySection,
	runnerBase,
	scriptedFetch,
} from "./helpers.js";

const EXPLAIN_SYSTEM = "203c55827859edb02c0a4ce8c155904e1115509781c600c7bf9529696940c791";
const MEMO_SYSTEM = "86410640a3cf140867b7258ba2038e86dd9807b616a60aace3250bad957a9fb2";
const EXPLAIN_USER = "6f3303b8757fd569c53989321198dce91f49ab4a99e9ae49c5842b335fef7b24";
const FOLLOWUP_USER = "9a349a2feb71928ad357f036075c661c208197d19fa20e8dd9a2bb4af11d6e5d";
const MEMO_USER = "316997efcc8a1688064ac995bb6bfa4a34b693bdccabaca6cbb7f90f0da8ad4b";
const REPAIR_TOOLS_USER = "2a1c3913d88f9e6e38d0a474eab0ea759797d700b5584a2fb6bcf3a5f05ef739";
const REPAIR_NO_TOOLS_USER = "c838a4201d4ad5cd565e1ce3b2ad151fbcfe1f1f029fcaced965eeb53b72223a";

const issues = [{ code: "X", path: "a.b" }];

function makeRunner(fetchImpl: typeof fetch) {
	return createAgentsPolicyExceptionRunner({
		...runnerBase,
		fetchImpl,
		policyClient: {} as never,
		actorId: "a",
		actorRole: "officer",
	});
}

const input = (extra: Record<string, unknown> = {}) => ({
	mode: "explain" as const,
	context: policyContext(),
	evidence: {
		...evidence,
		items: [
			...evidence.items,
			{ ...evidence.items[0]!, ref: "case_fact:pii", content: "Jane Q Example" },
		],
	},
	catalog: [policySection],
	actorId: "a",
	actorRole: "officer",
	maxTurns: 8,
	signal: AbortSignal.timeout(7_000),
	...extra,
});

describe("policy-exception manifest", () => {
	it("pins Terra, declares no model-callable tools, and runs in the request", () => {
		expect(definition).toMatchObject({
			name: "policy-exception",
			owner: "applications",
			model: { env: "POLICY_EXCEPTION_MODEL", default: "openai/gpt-6.1-terra" },
			versions: {
				prompt: "policy-exception-v1",
				agent: "policy-exception-agent-v1",
				validator: "policy-exception-validator-v1",
			},
			execution: "request",
		});
		expect(definition.tools).toEqual([]);
		expect(definition.flags).toEqual(["ASSIST_POLICY_EXCEPTION_ENABLED"]);
	});
});

describe("policy-exception prompts", () => {
	it("keeps the assembled prompts byte-identical to the pre-move values", async () => {
		const { fetchImpl, bodies } = scriptedFetch([() => completion()]);
		const runner = makeRunner(fetchImpl);
		const question = "Why did Jane Q Example fail? Call 555-1234";
		await runner.run(input());
		await runner.run(input({ mode: "followup", question }));
		await runner.run(input({ mode: "memo", question }));
		await runner.run(input({ repair: { previousOutput: "PREV", issues, requireTools: true } }));
		await runner.run(
			input({ mode: "memo", repair: { previousOutput: "PREV", issues, requireTools: false } }),
		);
		expect(bodies).toHaveLength(5);
		expect(messageHashes(bodies[0])).toEqual({ system: EXPLAIN_SYSTEM, user: EXPLAIN_USER });
		expect(messageHashes(bodies[1])).toEqual({ system: EXPLAIN_SYSTEM, user: FOLLOWUP_USER });
		expect(messageHashes(bodies[2])).toEqual({ system: MEMO_SYSTEM, user: MEMO_USER });
		expect(messageHashes(bodies[3])).toEqual({ system: EXPLAIN_SYSTEM, user: REPAIR_TOOLS_USER });
		expect(messageHashes(bodies[4])).toEqual({ system: MEMO_SYSTEM, user: REPAIR_NO_TOOLS_USER });
		// Single-shot: no tool definitions are ever sent to the model.
		expect((bodies[0] as { tools?: unknown }).tools).toBeUndefined();
	});
});

describe("policy-exception model-call retries", () => {
	it("retries a 503 and succeeds on the second call", async () => {
		const { fetchImpl, bodies } = scriptedFetch([() => errorResponse(503), () => completion("{}")]);
		const result = await makeRunner(fetchImpl).run(input());
		expect(result.rawOutput).toBe("{}");
		expect(bodies).toHaveLength(2);
	});

	it("does not retry a 401", async () => {
		const { fetchImpl, bodies } = scriptedFetch([() => errorResponse(401)]);
		const error = await makeRunner(fetchImpl)
			.run(input())
			.catch((err: unknown) => err);
		expect(error).toMatchObject({ name: "PolicyExceptionAgentError", code: "MODEL_ERROR" });
		expect(bodies).toHaveLength(1);
	});

	it("stops retrying when the caller aborts", async () => {
		const { fetchImpl, bodies } = scriptedFetch([() => errorResponse(503)]);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 150);
		const error = await makeRunner(fetchImpl)
			.run(input({ signal: controller.signal }))
			.catch((err: unknown) => err);
		expect(error).toMatchObject({ name: "PolicyExceptionAgentError", code: "TIMEOUT" });
		expect(bodies).toHaveLength(1);
	});
});
