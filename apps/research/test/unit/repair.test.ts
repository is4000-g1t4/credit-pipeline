// Language-repair unit tests: fake OpenAI client, no network.
import { describe, expect, it } from "vitest";
import {
	createLlmLanguageRepair,
	RepairRejectedError,
	stubLanguageRepair,
} from "../../src/repair.js";
import { fakeOpenAi, modelBrief, type RecordedCall } from "../fixtures.js";

describe("createLlmLanguageRepair", () => {
	it("rewrites only summary/claim/whyItMatters and preserves everything else", async () => {
		const recorded: RecordedCall[] = [];
		const repair = createLlmLanguageRepair(
			fakeOpenAi(
				{
					summary: "Registry shows timely filings in the public record.",
					findings: [
						{
							claim: "Acme Ltd filed accounts for the year ending March 2025 on time.",
							whyItMatters: "Timely filing is part of the public record.",
						},
					],
				},
				recorded,
			),
			"deepseek/deepseek-v4.1-flash-1017",
		);
		const before = modelBrief();
		const out = await repair(before);
		expect(recorded).toHaveLength(1);
		const params = recorded[0].params as Record<string, unknown>;
		expect(params.model).toBe("deepseek/deepseek-v4.1-flash-1017");
		expect(params.temperature).toBe(0);
		expect(params.response_format).toEqual({ type: "json_object" });
		expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
		expect(out.brief.summary).toBe("Registry shows timely filings in the public record.");
		expect(out.brief.findings[0].whyItMatters).toBe("Timely filing is part of the public record.");
		// Untouched: evidence, citations, contradictions, unknowns, questions.
		expect(out.brief.evidence).toEqual(before.evidence);
		expect(out.brief.findings[0].evidenceLocalIds).toEqual(["ev-1"]);
		expect(out.brief.contradictions).toEqual(before.contradictions);
		expect(out.brief.unknowns).toEqual(before.unknowns);
		expect(out.brief.questionsForOfficer).toEqual(before.questionsForOfficer);
	});

	it("rejects a reply that changes the finding count", async () => {
		const recorded: RecordedCall[] = [];
		const repair = createLlmLanguageRepair(
			fakeOpenAi({ summary: "Clean.", findings: [] }, recorded),
			"deepseek/deepseek-v4.1-flash-1017",
		);
		await expect(repair(modelBrief())).rejects.toBeInstanceOf(RepairRejectedError);
	});

	it("rejects invalid JSON", async () => {
		const recorded: RecordedCall[] = [];
		const repair = createLlmLanguageRepair(
			fakeOpenAi("not json", recorded),
			"deepseek/deepseek-v4.1-flash-1017",
		);
		await expect(repair(modelBrief())).rejects.toBeInstanceOf(RepairRejectedError);
	});
});

describe("stubLanguageRepair", () => {
	it("passes through by default and counts calls", async () => {
		const stub = stubLanguageRepair();
		const brief = modelBrief();
		const out = await stub(brief);
		expect(out.brief).toBe(brief);
		expect(stub.calls).toBe(1);
	});
});
