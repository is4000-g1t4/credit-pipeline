import { describe, expect, it } from "vitest";
import {
	evidenceBundleSchema,
	evidenceIndex,
	parseSourceRef,
	hashQuote,
	sourceRefKey,
	type EvidenceBundle,
	type SourceRef,
} from "../src/evidence.js";

const documentId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const scoreId = "33333333-3333-4333-8333-333333333333";
const evidenceId = "44444444-4444-4444-8444-444444444444";
const appId = "55555555-5555-4555-8555-555555555555";

const refs: SourceRef[] = [
	{ type: "document", documentFileId: documentId, pageNumber: 2, offsetStart: 10, offsetEnd: 42 },
	{
		type: "context_signal",
		signalRef: "signal:negative_balance:negative_eod_days:2026-01-01:2026-06-30:aggregate",
	},
	{ type: "external_evidence", evidenceId },
	{
		type: "policy_section",
		policyKey: "POL-CR-002",
		policyVersionId: versionId,
		sectionId: "4.2",
		quoteHash: hashQuote("DSCR must be at least 1.25x."),
	},
	{ type: "score_reason", scoreId, code: "SCORE_IN_REFER_BAND" },
	{ type: "case_fact", applicationId: appId, field: "business.annualRevenueCents" },
];

describe("sourceRef contract", () => {
	it("round-trips every source type through a stable key", () => {
		for (const ref of refs) {
			const key = sourceRefKey(ref);
			expect(parseSourceRef(key)).toEqual(ref);
			expect(sourceRefKey(parseSourceRef(key) as SourceRef)).toBe(key);
		}
	});

	it("keys are stable for the same span", () => {
		expect(sourceRefKey(refs[0])).toBe(`document:${documentId}:p2:10-42`);
		expect(sourceRefKey(refs[1])).toBe(
			"context_signal:signal:negative_balance:negative_eod_days:2026-01-01:2026-06-30:aggregate",
		);
		expect(sourceRefKey(refs[2])).toBe(`external_evidence:${evidenceId}`);
		expect(sourceRefKey(refs[5])).toBe(`case_fact:${appId}:business.annualRevenueCents`);
	});

	it("rejects malformed refs instead of guessing", () => {
		expect(parseSourceRef("document:nope:p1:0-1")).toBeNull();
		expect(parseSourceRef("document:not-a-uuid:p1:0-1")).toBeNull();
		expect(parseSourceRef("policy_section:not-a-uuid:1:abc")).toBeNull();
		expect(parseSourceRef("score_reason:not-a-uuid:CODE")).toBeNull();
		expect(parseSourceRef("unknown:thing")).toBeNull();
		expect(parseSourceRef("document:" + documentId + ":p1:10-10")).toBeNull();
	});
});

function bundle(): EvidenceBundle {
	return {
		applicationId: appId,
		asOf: "2026-06-30T00:00:00.000Z",
		assembledAt: "2026-06-30T01:00:00.000Z",
		items: refs.map((ref) => ({
			ref: sourceRefKey(ref),
			sourceType: ref.type,
			label: ref.type,
			content: `content for ${ref.type}`,
			access: { retentionUntil: null, legalHold: false },
			metadata: {},
		})),
		unavailable: [
			{
				ref: `document:${documentId}:p3:0-5`,
				sourceType: "document",
				code: "retention_expired",
			},
		],
	};
}

describe("evidence bundle schema", () => {
	it("accepts a typed bundle", () => {
		const parsed = evidenceBundleSchema.parse(bundle());
		expect(parsed.items).toHaveLength(refs.length);
		expect(parsed.unavailable[0]?.code).toBe("retention_expired");
	});

	it("rejects an unknown source type or access shape", () => {
		const unknown = { ...bundle(), items: [{ ...bundle().items[0], sourceType: "email" }] };
		expect(evidenceBundleSchema.safeParse(unknown).success).toBe(false);
		const badAccess = {
			...bundle(),
			items: [{ ...bundle().items[0], access: { legalHold: false } }],
		};
		expect(evidenceBundleSchema.safeParse(badAccess).success).toBe(false);
	});

	it("indexes items and unavailable sources by ref", () => {
		const index = evidenceIndex(bundle());
		expect(index.items.size).toBe(refs.length);
		expect(index.unavailable.size).toBe(1);
		expect(index.items.get(sourceRefKey(refs[0]))?.sourceType).toBe("document");
	});
});
