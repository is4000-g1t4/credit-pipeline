// Case-assistant unit tests: answer validation, trace metadata, policy
// query construction, and the scripted runner. No model or network.
import { describe, expect, it } from "vitest";
import {
	buildPolicySearchBody,
	CaseAssistantError,
	citedPolicyRefs,
	compactPolicySection,
	createRealCaseAssistantRunner,
	policySearchQuery,
	stubCaseAssistantRunner,
	toolTraceEntry,
	validateCaseAssistantAnswer,
	CASE_ASSISTANT_PROMPT_VERSION,
} from "../../src/case-assistant.js";
import { loadEnv } from "../../src/env.js";

const caseFacts = {
	applicantName: "Jane Doe",
	companyName: "Acme Ltd",
	type: "sme",
};

describe("validateCaseAssistantAnswer", () => {
	it("accepts a clean answer", () => {
		expect(() =>
			validateCaseAssistantAnswer("The file shows two accounts with steady inflows.", caseFacts),
		).not.toThrow();
	});

	it("rejects empty and non-string answers as INVALID_OUTPUT", () => {
		for (const bad of ["", "   ", null, undefined, 42]) {
			try {
				validateCaseAssistantAnswer(bad, caseFacts);
				expect.unreachable();
			} catch (err) {
				expect(err).toBeInstanceOf(CaseAssistantError);
				expect((err as CaseAssistantError).code).toBe("INVALID_OUTPUT");
			}
		}
	});

	it("rejects overlong answers as INVALID_OUTPUT", () => {
		try {
			validateCaseAssistantAnswer("x".repeat(4001), caseFacts);
			expect.unreachable();
		} catch (err) {
			expect((err as CaseAssistantError).code).toBe("INVALID_OUTPUT");
		}
	});

	it("rejects decision language as UNSAFE_OUTPUT", () => {
		for (const answer of [
			"This supports approval of the request.",
			"I recommend moving forward.",
			"The file should be declined.",
		]) {
			try {
				validateCaseAssistantAnswer(answer, caseFacts);
				expect.unreachable(`accepted: ${answer}`);
			} catch (err) {
				expect((err as CaseAssistantError).code).toBe("UNSAFE_OUTPUT");
			}
		}
	});

	it("rejects direct identifiers as UNSAFE_OUTPUT", () => {
		for (const answer of [
			"Contact jane@example.com for details.",
			"NRIC S1234567A is on file.",
			"Call 9123 4567 to verify.",
		]) {
			try {
				validateCaseAssistantAnswer(answer, caseFacts);
				expect.unreachable(`accepted: ${answer}`);
			} catch (err) {
				expect((err as CaseAssistantError).code).toBe("UNSAFE_OUTPUT");
			}
		}
	});

	it("rejects the applicant name but allows the company name", () => {
		for (const answer of ["Jane Doe holds two accounts.", "JANE DOE is the applicant."]) {
			try {
				validateCaseAssistantAnswer(answer, caseFacts);
				expect.unreachable(`accepted: ${answer}`);
			} catch (err) {
				expect((err as CaseAssistantError).code).toBe("UNSAFE_OUTPUT");
			}
		}
		expect(() => validateCaseAssistantAnswer("The company is Acme Ltd.", caseFacts)).not.toThrow();
	});
});

describe("citedPolicyRefs", () => {
	const ref = (policyKey: string, sectionId: string) => ({
		policyKey,
		sectionId,
		heading: "heading",
		version: "v1",
		effectiveFrom: "2026-01-01",
		policyVersionId: "pv",
		quote: "quote",
		drawerToken: "token",
	});

	it("keeps only sections the answer cites", () => {
		const refs = [ref("POL-CR-009", "9.2"), ref("POL-CR-003", "3.4")];
		expect(citedPolicyRefs("See POL-CR-009 §9.2.", refs)).toEqual([refs[0]]);
		expect(citedPolicyRefs("See POL-CR-003 3.4.", refs)).toEqual([refs[1]]);
		expect(citedPolicyRefs("No policy used.", refs)).toEqual([]);
	});
});

describe("toolTraceEntry", () => {
	it("counts arrays by length and objects as one", () => {
		expect(toolTraceEntry("list_accounts", { accounts: [1, 2] })).toEqual({
			name: "list_accounts",
			resultCount: 2,
			sourceTypes: ["accounts"],
		});
		expect(toolTraceEntry("get_documents", [1, 2, 3]).resultCount).toBe(3);
		expect(toolTraceEntry("search_policy", { sections: [1, 2, 3, 4] }).resultCount).toBe(4);
		expect(toolTraceEntry("get_loans", null).resultCount).toBe(0);
	});

	it("maps policy and external tools to their source types", () => {
		expect(toolTraceEntry("search_policy", { sections: [] }).sourceTypes).toEqual(["policy"]);
		expect(toolTraceEntry("get_external_reports", []).sourceTypes).toEqual(["bureau/bank"]);
		expect(toolTraceEntry("get_external_research_summary", null).sourceTypes).toEqual(["research"]);
	});
});

describe("policySearchQuery", () => {
	it("scrubs known case names, UEN, and city before embedding", () => {
		const out = policySearchQuery("Acme Ltd UEN 201933333R in Singapore asks about TDSR", {
			...caseFacts,
			registrationNumber: "201933333R",
			city: "Singapore",
		});
		expect(out).not.toContain("Acme Ltd");
		expect(out).not.toContain("201933333R");
		expect(out).not.toContain("Singapore");
		expect(out).toContain("TDSR");
	});
});

describe("buildPolicySearchBody", () => {
	it("builds the bridge body with product scope and topK 4", () => {
		expect(
			buildPolicySearchBody({
				applicationId: "app-1",
				actorId: "officer-1",
				actorRole: "officer",
				asOfDate: "2026-01-15",
				caseType: "sme",
				query: "What mitigants apply?",
			}),
		).toEqual({
			applicationId: "app-1",
			actorId: "officer-1",
			actorRole: "officer",
			policyAsOf: "2026-01-15",
			productScope: "sme",
			query: "What mitigants apply?",
			topK: 4,
		});
	});

	it("maps non-sme types to individual", () => {
		const body = buildPolicySearchBody({
			applicationId: "app-1",
			actorId: "officer-1",
			actorRole: "officer",
			asOfDate: "2026-01-15",
			caseType: "individual",
			query: "What mitigants apply?",
		});
		expect(body.productScope).toBe("individual");
	});
});

describe("compactPolicySection", () => {
	it("compacts a section with a 600-char quote", () => {
		const { section, ref } = compactPolicySection({
			policyKey: "POL-CR-001",
			sectionId: "3.2",
			heading: "Mitigants",
			version: "v4",
			effectiveFrom: "2025-01-01",
			policyVersionId: "11111111-1111-4111-8111-111111111111",
			body: "x".repeat(1000),
			drawerToken: "token-1",
		});
		expect((section["quote"] as string).length).toBe(600);
		expect(ref).toMatchObject({ policyKey: "POL-CR-001", sectionId: "3.2" });
	});

	it("returns a null ref for malformed rows", () => {
		expect(compactPolicySection({}).ref).toBeNull();
	});
});

describe("stubCaseAssistantRunner", () => {
	it("returns scripted outputs and counts calls", async () => {
		const stub = stubCaseAssistantRunner({
			outputs: [{ answer: "First.", limitations: [] }],
		});
		const out = await stub.run({
			applicationId: "app-1",
			caseFacts: {},
			asOfDate: "2026-01-15",
			question: "q",
			history: [],
			actorId: "officer-1",
			actorRole: "officer",
			signal: AbortSignal.timeout(1000),
		});
		expect(out.answer).toBe("First.");
		expect(out.promptVersion).toBe(CASE_ASSISTANT_PROMPT_VERSION);
		expect(stub.calls).toBe(1);
	});

	it("throws the scripted error", async () => {
		const stub = stubCaseAssistantRunner({
			outputs: [],
			throw: new CaseAssistantError("CASE_ASSISTANT_TIMEOUT", "timed out"),
		});
		await expect(
			stub.run({
				applicationId: "app-1",
				caseFacts: {},
				asOfDate: "2026-01-15",
				question: "q",
				history: [],
				actorId: "officer-1",
				actorRole: "officer",
				signal: AbortSignal.timeout(1000),
			}),
		).rejects.toMatchObject({ code: "CASE_ASSISTANT_TIMEOUT" });
	});
});

describe("createRealCaseAssistantRunner", () => {
	it("fails closed without a model key", async () => {
		const env = { ...loadEnv(), openrouterApiKey: "" };
		const runner = createRealCaseAssistantRunner({ env, openai: {} as never });
		await expect(
			runner.run({
				applicationId: "app-1",
				caseFacts: {},
				asOfDate: "2026-01-15",
				question: "q",
				history: [],
				actorId: "officer-1",
				actorRole: "officer",
				signal: AbortSignal.timeout(1000),
			}),
		).rejects.toMatchObject({ code: "CASE_ASSISTANT_UNAVAILABLE" });
	});
});
