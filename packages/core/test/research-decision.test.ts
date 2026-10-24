// Phase 2 R0: public/internal officer-decision split (SPEC §3.4–3.5) plus
// the city/consent contract. Public selection only; the frozen bundle
// travels the internal schema alone.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	applicationCreateSchema,
	internalOfficerDecisionSchema,
	officerDecisionSchema,
	type ResearchBundle,
} from "../src/schemas.js";

const decisionBase = {
	requestId: randomUUID(),
	outcome: "approve",
} as const;

function bundle(): ResearchBundle {
	return {
		agentRunId: randomUUID(),
		applicationId: randomUUID(),
		briefHash: "sha256:abc",
		viewedAt: null,
		acceptedFindings: [
			{
				findingId: randomUUID(),
				claim: "Registry shows the company active since 2020.",
				category: "registry",
				entityMatch: {
					identifierType: "registration_number",
					value: "CAFEAUR1",
					confidence: "high",
				},
				evidence: [
					{
						url: "https://registry.example/records/1",
						quote: "Active since 2020.",
						snapshotHash: "sha256:def",
					},
				],
			},
		],
	};
}

describe("officerDecisionSchema (public)", () => {
	it("accepts a plain approve/decline decision", () => {
		expect(officerDecisionSchema.safeParse(decisionBase).success).toBe(true);
		expect(
			officerDecisionSchema.safeParse({
				...decisionBase,
				outcome: "decline",
				reasonCode: "OFFICER_JUDGEMENT",
				notes: "Thin file.",
			}).success,
		).toBe(true);
	});

	it("accepts paired agentRunId + acceptedFindingIds", () => {
		const parsed = officerDecisionSchema.safeParse({
			...decisionBase,
			agentRunId: randomUUID(),
			acceptedFindingIds: [randomUUID()],
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects a lone agentRunId or lone acceptedFindingIds", () => {
		expect(
			officerDecisionSchema.safeParse({ ...decisionBase, agentRunId: randomUUID() }).success,
		).toBe(false);
		expect(
			officerDecisionSchema.safeParse({ ...decisionBase, acceptedFindingIds: [randomUUID()] })
				.success,
		).toBe(false);
	});

	it("rejects a client-supplied research bundle", () => {
		const parsed = officerDecisionSchema.safeParse({ ...decisionBase, research: bundle() });
		expect(parsed.success).toBe(false);
	});
});

describe("internalOfficerDecisionSchema", () => {
	it("accepts an ordinary decision with no research", () => {
		expect(internalOfficerDecisionSchema.safeParse(decisionBase).success).toBe(true);
	});

	it("accepts the server-built frozen bundle", () => {
		const parsed = internalOfficerDecisionSchema.safeParse({
			...decisionBase,
			research: bundle(),
		});
		expect(parsed.success).toBe(true);
	});

	it("accepts offset timestamps and null for viewedAt", () => {
		const withOffset = { ...bundle(), viewedAt: "2026-01-15T10:00:00+00:00" };
		const parsed = internalOfficerDecisionSchema.safeParse({
			...decisionBase,
			research: withOffset,
		});
		expect(parsed.success).toBe(true);
		const nulled = { ...bundle(), viewedAt: null };
		expect(
			internalOfficerDecisionSchema.safeParse({
				...decisionBase,
				research: nulled,
			}).success,
		).toBe(true);
	});

	it("rejects the public selection fields (review strips them)", () => {
		// The selection lives only on the public schema; anything carrying
		// agentRunId/acceptedFindingIds fails the strict internal shape.
		expect(
			internalOfficerDecisionSchema.safeParse({
				...decisionBase,
				research: bundle(),
				agentRunId: randomUUID(),
				acceptedFindingIds: [randomUUID()],
			}).success,
		).toBe(false);
		expect(
			internalOfficerDecisionSchema.safeParse({
				...decisionBase,
				research: bundle(),
				agentRunId: randomUUID(),
			}).success,
		).toBe(false);
	});
});

describe("city + aiResearchConsent", () => {
	const validApplication = {
		type: "individual",
		product: "personal_loan",
		amountCents: 1_200_000,
		termMonths: 48,
		purpose: "test",
		consents: [true, true, true],
		identity: {
			fullName: "Test Person",
			dob: "1990-01-01",
			nationalId: "TEST1234",
			email: "test@example.com",
			phone: "+1-555-0000",
			address: "1 Test Street",
			city: "Demo City",
		},
		individual: {
			employmentStatus: "employed",
			employerName: "Acme",
			employmentYears: 5,
			monthlyIncomeCents: 420_000,
			existingDebtCents: 0,
			bankRelationshipYears: 3,
		},
	};

	it("requires city (2–80 chars) on new applications", () => {
		expect(applicationCreateSchema.safeParse(validApplication).success).toBe(true);
		const { city: _omitted, ...identityWithoutCity } = validApplication.identity;
		expect(
			applicationCreateSchema.safeParse({ ...validApplication, identity: identityWithoutCity })
				.success,
		).toBe(false);
		for (const city of ["x", "x".repeat(81)]) {
			expect(
				applicationCreateSchema.safeParse({
					...validApplication,
					identity: { ...validApplication.identity, city },
				}).success,
			).toBe(false);
		}
		for (const city of ["xx", "x".repeat(80)]) {
			expect(
				applicationCreateSchema.safeParse({
					...validApplication,
					identity: { ...validApplication.identity, city },
				}).success,
			).toBe(true);
		}
	});

	it("defaults aiResearchConsent to false and keeps the 3-consent array", () => {
		for (const consents of [
			[true, true],
			[true, true, true, true],
		]) {
			expect(applicationCreateSchema.safeParse({ ...validApplication, consents }).success).toBe(
				false,
			);
		}
		const parsed = applicationCreateSchema.safeParse(validApplication);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.aiResearchConsent).toBe(false);
		const optedIn = applicationCreateSchema.safeParse({
			...validApplication,
			aiResearchConsent: true,
		});
		expect(optedIn.success).toBe(true);
		if (optedIn.success) expect(optedIn.data.aiResearchConsent).toBe(true);
	});
});
