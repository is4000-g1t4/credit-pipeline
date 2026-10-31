// integrity agent: manifest, prompt byte-equality, and model-call retries.
// No DB, no network. Hashes were captured before the prompts moved into
// instructions.md / brief.md.
import { describe, expect, it } from "vitest";
import {
	INTEGRITY_TOOL_NAMES,
	createAgentsIntegrityRunner,
	definition,
} from "../../src/agents/integrity/index.js";
import {
	completion,
	errorResponse,
	integritySource,
	messageHashes,
	runnerBase,
	scriptedFetch,
	sha256,
} from "./helpers.js";

const ANALYSIS_SYSTEM = "8a2f45e7295fbcbe59f69428872d66366812074ccb040430e8347494d2c0a4f0";
const BRIEF_SYSTEM = "980e8616f3b98600dc8e0a84cf85dbef800ac52d9f685286c85513dc53e83a8c";
const ANALYSIS_USER = "630147ab5e14d08e9a8fb3917ad1e29de12ec116a5c55fdf42b3ccdb5e52f76d";
const BRIEF_USER = "af6fee55da2963f5ceb24bcb3064452a0d3c78eb9dcddbdf9947d585db8387cb";
const REPAIR_USER = "c00437096dd344677e3550a3e521f1c0fc0237b46d380938d3186db073cb3e2c";
const ANALYSIS_TOOLS = "f42fb3a09cc5da5af6275df1add7286d8a730830a1be347240a7f73fda8b069e";
const BRIEF_TOOLS = "e4de6622bb6f8342ba7592550f77799ec328ae5332ae9d6b0d9b933c272163d7";

const issues = [{ code: "X", path: "a.b" }];

const input = (extra: Record<string, unknown> = {}) => ({
	mode: "analysis" as const,
	source: integritySource,
	maxTurns: 8,
	signal: AbortSignal.timeout(7_000),
	...extra,
});

describe("integrity manifest", () => {
	it("pins Sol, the temporal execution mode, and the allowlisted tools", () => {
		expect(definition).toMatchObject({
			name: "integrity",
			owner: "applications",
			model: { env: "DOCUMENT_INTEGRITY_MODEL", default: "openai/gpt-6.1-sol" },
			versions: { prompt: "integrity-analysis-v1", agent: "integrity-agent-v1" },
			execution: "temporal",
		});
		expect(definition.tools).toEqual([...INTEGRITY_TOOL_NAMES]);
		expect(definition.flags).toContain("DOCUMENT_INTEGRITY_AGENT_ENABLED");
	});
});

describe("integrity prompts", () => {
	it("keeps the assembled prompts and tool definitions byte-identical", async () => {
		const { fetchImpl, bodies } = scriptedFetch([() => completion()]);
		const runner = createAgentsIntegrityRunner({ ...runnerBase, fetchImpl });
		await runner.run(input());
		await runner.run(input({ repair: { previousOutput: "PREV", issues } }));
		await runner.run(input({ generateBrief: true }));
		await runner.run(input({ generateBrief: true, repair: { previousOutput: "PREV", issues } }));
		expect(bodies).toHaveLength(4);
		expect(messageHashes(bodies[0])).toEqual({ system: ANALYSIS_SYSTEM, user: ANALYSIS_USER });
		expect(messageHashes(bodies[1])).toEqual({ system: ANALYSIS_SYSTEM, user: REPAIR_USER });
		expect(messageHashes(bodies[2])).toEqual({ system: BRIEF_SYSTEM, user: BRIEF_USER });
		expect(messageHashes(bodies[3])).toEqual({ system: BRIEF_SYSTEM, user: REPAIR_USER });
		const tools = (body: unknown) => sha256(JSON.stringify((body as { tools: unknown }).tools));
		expect(tools(bodies[0])).toBe(ANALYSIS_TOOLS);
		expect(tools(bodies[2])).toBe(BRIEF_TOOLS);
	});
});

describe("integrity model-call retries", () => {
	it("retries a 503 and succeeds on the second call", async () => {
		const { fetchImpl, bodies } = scriptedFetch([() => errorResponse(503), () => completion()]);
		const result = await createAgentsIntegrityRunner({ ...runnerBase, fetchImpl }).run(input());
		expect(result.rawOutput).toBe("{}");
		expect(bodies).toHaveLength(2);
	});

	it("does not retry a 401", async () => {
		const { fetchImpl, bodies } = scriptedFetch([() => errorResponse(401)]);
		const error = await createAgentsIntegrityRunner({ ...runnerBase, fetchImpl })
			.run(input())
			.catch((err: unknown) => err);
		expect(error).toMatchObject({ name: "IntegrityAgentError", code: "MODEL_ERROR" });
		expect(bodies).toHaveLength(1);
	});

	it("stops retrying when the caller aborts", async () => {
		const { fetchImpl, bodies } = scriptedFetch([() => errorResponse(503)]);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 150);
		const error = await createAgentsIntegrityRunner({ ...runnerBase, fetchImpl })
			.run(input({ signal: controller.signal }))
			.catch((err: unknown) => err);
		expect(error).toMatchObject({ name: "IntegrityAgentError", code: "TIMEOUT" });
		expect(bodies).toHaveLength(1);
	});
});
