// memo-writer: manifest, prompt byte-equality, and model-call retries.
// No DB, no network. The prompt hashes are the sha256 of the assembled
// system/user messages captured BEFORE the prompts moved into
// instructions.md, so any byte drift in the move fails here.
import { describe, expect, it } from "vitest";
import {
	MEMO_TOOL_NAMES,
	createAgentsMemoRunner,
	definition,
} from "../../src/agents/memo-writer/index.js";
import {
	application,
	completion,
	errorResponse,
	evidence,
	messageHashes,
	runnerBase,
	scriptedFetch,
	sha256,
} from "./helpers.js";

const SYSTEM = "ce6628b57cc63dd4ea3dd41293808bb6ba62033aa85eddb3656e9864faf0092e";
const INITIAL_USER = "fa5a45b42aa4c8cd11e1fc03b4858ce7c878c51fa546d36410319b4434f19fac";
const REPAIR_TOOLS_USER = "5168bbfab4c404ca53015f5a6aa1ba2cd68a8388fb6a5018c129f227e4d1c5fe";
const REPAIR_NO_TOOLS_USER = "d3f47d69f25b026f9b2d0440d59c5219deea706c7f580e0ac4f2f67b71be6e03";
const TOOLS_HASH = "0c173f619a97d91e4fcdbd85c3e73b11e63e534b447a6d8d0fa8cd81f5cfd0cf";

const issues = [{ code: "X", path: "a.b" }];

describe("memo-writer manifest", () => {
	it("pins Sol, the request execution mode, and the evidence tools", () => {
		expect(definition).toMatchObject({
			name: "memo-writer",
			owner: "applications",
			model: { env: "ASSIST_MEMO_MODEL", default: "openai/gpt-6.1-sol" },
			versions: { prompt: "memo-agent-v1", agent: "memo-agent-v1" },
			execution: "request",
		});
		expect(definition.flags).toEqual(["ASSIST_ENABLED", "ASSIST_MEMO_WRITER"]);
		expect(definition.tools).toEqual([...MEMO_TOOL_NAMES]);
	});
});

describe("memo-writer prompts", () => {
	it("keeps the assembled prompts byte-identical to the pre-move values", async () => {
		const { fetchImpl, bodies } = scriptedFetch([() => completion()]);
		const runner = createAgentsMemoRunner({ ...runnerBase, fetchImpl });
		const run = (repair?: { requireTools: boolean }) =>
			runner.run({
				application,
				evidence,
				signal: AbortSignal.timeout(5_000),
				maxTurns: 8,
				...(repair
					? { repair: { previousOutput: "PREV", issues, requireTools: repair.requireTools } }
					: {}),
			});
		await run();
		await run({ requireTools: true });
		await run({ requireTools: false });
		expect(bodies).toHaveLength(3);
		expect(messageHashes(bodies[0])).toEqual({ system: SYSTEM, user: INITIAL_USER });
		expect(messageHashes(bodies[1])).toEqual({ system: SYSTEM, user: REPAIR_TOOLS_USER });
		expect(messageHashes(bodies[2])).toEqual({ system: SYSTEM, user: REPAIR_NO_TOOLS_USER });
		expect(sha256(JSON.stringify((bodies[0] as { tools: unknown }).tools))).toBe(TOOLS_HASH);
	});
});

describe("memo-writer model-call retries", () => {
	const input = () => ({
		application,
		evidence,
		signal: AbortSignal.timeout(7_000),
		maxTurns: 8,
	});

	it("retries a 503 and succeeds on the second call", async () => {
		const { fetchImpl, bodies } = scriptedFetch([() => errorResponse(503), () => completion()]);
		const result = await createAgentsMemoRunner({ ...runnerBase, fetchImpl }).run(input());
		expect(result.rawOutput).toBe("{}");
		expect(bodies).toHaveLength(2);
	});

	it("does not retry a 401", async () => {
		const { fetchImpl, bodies } = scriptedFetch([() => errorResponse(401)]);
		const error = await createAgentsMemoRunner({ ...runnerBase, fetchImpl })
			.run(input())
			.catch((err: unknown) => err);
		expect(error).toMatchObject({ name: "MemoAgentError", code: "MODEL_ERROR" });
		expect(bodies).toHaveLength(1);
	});

	it("stops retrying when the caller aborts", async () => {
		const { fetchImpl, bodies } = scriptedFetch([() => errorResponse(503)]);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 150);
		const error = await createAgentsMemoRunner({ ...runnerBase, fetchImpl })
			.run({ ...input(), signal: controller.signal })
			.catch((err: unknown) => err);
		expect(error).toMatchObject({ name: "MemoAgentError", code: "TIMEOUT" });
		expect(bodies).toHaveLength(1);
	});
});
