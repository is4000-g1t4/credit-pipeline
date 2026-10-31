// memo-trace unit tests: no DB. Schema shape, validation, hash stability.
import { describe, expect, it } from "vitest";
import type { EvidenceBundle } from "@credit/core";
import {
	evidenceHash,
	memoAgentTraceSchema,
	type MemoAgentTrace,
} from "../../src/agents/shared/trace.js";

function validTrace(): MemoAgentTrace {
	return {
		writer: "agent",
		agentVersion: "memo-agent-v1",
		model: "deepseek/deepseek-v4.1-flash-1017",
		promptVersion: "memo-agent-v1",
		evidenceHash: "deadbeef",
		steps: 3,
		toolCalls: [
			{ step: 1, name: "list_evidence", resultCount: 12, sourceTypes: ["case_fact"] },
			{ step: 2, name: "get_evidence", resultCount: 1, sourceTypes: ["score_reason"] },
		],
		sourceRefs: ["case_fact:app:amountCents"],
		repairAttempted: true,
		repairSucceeded: true,
		fallbackReason: null,
		inputTokens: 100,
		outputTokens: 200,
		latencyMs: 123,
	};
}

function bundle(assembledAt: string): EvidenceBundle {
	return {
		applicationId: "55555555-5555-4555-8555-555555555555",
		asOf: "2026-01-01T00:00:00.000Z",
		assembledAt,
		items: [],
		unavailable: [],
	};
}

describe("memoAgentTraceSchema", () => {
	it("accepts the spec shape and both writers", () => {
		expect(memoAgentTraceSchema.safeParse(validTrace()).success).toBe(true);
		expect(
			memoAgentTraceSchema.safeParse({ ...validTrace(), writer: "deterministic" }).success,
		).toBe(true);
	});

	it("rejects invalid traces", () => {
		expect(memoAgentTraceSchema.safeParse({ ...validTrace(), writer: "model" }).success).toBe(
			false,
		);
		expect(memoAgentTraceSchema.safeParse({ ...validTrace(), inputTokens: -1 }).success).toBe(
			false,
		);
		const { steps: _omitted, ...missing } = validTrace();
		expect(memoAgentTraceSchema.safeParse(missing).success).toBe(false);
	});

	it("strips unknown keys instead of failing (normalize)", () => {
		const parsed = memoAgentTraceSchema.safeParse({ ...validTrace(), chainOfThought: "x" });
		expect(parsed.success).toBe(true);
		expect(parsed.data).not.toHaveProperty("chainOfThought");
	});
});

describe("evidenceHash", () => {
	it("is stable and ignores volatile assembly timestamps", () => {
		expect(evidenceHash(bundle("2026-01-01T00:00:00.000Z"))).toBe(
			evidenceHash(bundle("2026-06-30T12:34:56.000Z")),
		);
	});

	it("changes when evidence changes", () => {
		const base = bundle("2026-01-01T00:00:00.000Z");
		const changed: EvidenceBundle = {
			...base,
			unavailable: [{ ref: "document:x", sourceType: "document", code: "missing" }],
		};
		expect(evidenceHash(changed)).not.toBe(evidenceHash(base));
	});
});
