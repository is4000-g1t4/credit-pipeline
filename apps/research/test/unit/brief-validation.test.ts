// Direct validateAndBuild coverage: one accept (verbatim registry quote
// survives with no judge call) and one reject (bad citation drops the
// finding without judging another passage's quote).
import { describe, expect, it } from "vitest";
import { validateAndBuild } from "../../src/brief-validation.js";
import type { LanguageRepair } from "../../src/repair.js";
import type { SupportJudge } from "../../src/support.js";
import type { CaseEntity } from "../../src/validator.js";
import { modelBrief } from "../fixtures.js";

const ENTITY: CaseEntity = {
	kind: "sme",
	applicantName: "Jane Doe",
	companyName: "Acme Ltd",
	registrationNumber: "12345678",
	city: "Leeds",
};

const QUOTE = "Acme Ltd filed accounts for the year ending March 2025 on time.";
const URL = "https://find-and-update.company-information.service.gov.uk/company/123";

function cleanBrief() {
	const base = modelBrief();
	return {
		...base,
		// Default fixture text carries decision language the repair pass
		// would rewrite; keep this unit repair-free with clean wording.
		summary: "Registry shows timely filings in the public record.",
		findings: base.findings.map((f) => ({
			...f,
			whyItMatters: "Timely filing is part of the public record.",
		})),
	};
}

function fetched() {
	return [
		{
			requestedUrl: URL,
			returnedUrl: URL,
			title: "Filings",
			searchPublishedDate: null,
			// Model date appears verbatim so date verification resolves it.
			rawContent: `Published 2025-06-01.\n${QUOTE}\nfooter`,
		},
	];
}

describe("validateAndBuild", () => {
	it("accepts a verbatim registry quote without spending a judge call", async () => {
		let judgeCalls = 0;
		const judge: SupportJudge = async () => {
			judgeCalls += 1;
			return { verdict: "supported", span: QUOTE };
		};
		const repair: LanguageRepair = async (brief) => ({ brief });
		const out = await validateAndBuild({
			brief: cleanBrief(),
			fetched: fetched(),
			entity: ENTITY,
			asOf: "2026-01-15",
			judge,
			repair,
			runId: "run-1",
		});
		expect(out.findings).toHaveLength(1);
		expect(out.evidence).toHaveLength(1);
		expect(out.findings[0].claim).toBe(QUOTE);
		expect(out.links).toHaveLength(1);
		expect(judgeCalls).toBe(0);
	});

	it("rejects a finding whose citation survives nowhere", async () => {
		let judgeCalls = 0;
		const judge: SupportJudge = async () => {
			judgeCalls += 1;
			return { verdict: "supported", span: QUOTE };
		};
		const repair: LanguageRepair = async (brief) => ({ brief });
		const out = await validateAndBuild({
			brief: {
				...cleanBrief(),
				evidence: [
					{
						localId: "ev-1",
						url: "https://example.com/missing",
						title: "Missing",
						publisher: "Unknown",
						publishedAt: "2025-06-01",
						quote: QUOTE,
					},
				],
			},
			fetched: [],
			entity: ENTITY,
			asOf: "2026-01-15",
			judge,
			repair,
			runId: "run-1",
		});
		expect(out.findings).toHaveLength(0);
		expect(out.brief.summary).toBe("No supported findings remained after validation.");
		expect(judgeCalls).toBe(0);
		const validation = out.validation as {
			unsupportedClaims: number;
			discarded: Array<{ reason: string }>;
		};
		expect(validation.unsupportedClaims).toBe(1);
		expect(validation.discarded[0].reason).toBe("cited evidence did not survive validation");
	});
});
