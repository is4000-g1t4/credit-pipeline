// Manifest determinism + BreadTalk fixture contract (SPEC-t17-t18 §2.5).
// Compose-free: loads the checked-in manifest and pins every date the demo
// sequence depends on (stale at DEMO_AS_OF-120d/-24mo, fresh inside the
// 90d/18mo policy), the balance-chain integrity, PDF determinism, and the
// version/hash gate.
import { describe, expect, it } from "vitest";
import { statementFreshness } from "../../apps/applications/src/customer/requirements.js";
import { sha256Hex } from "../../apps/applications/src/customer/crypto.js";
import { demoEvidenceBytes, demoPdfForLines } from "../lib/demo-pdf.js";
import {
	assertFixtureClock,
	assertManifest,
	demoAsOfDate,
	loadManifest,
	manifestHash,
	EXPECTED_MANIFEST_SHA256,
	EXPECTED_MANIFEST_VERSION,
} from "../lib/manifest.js";

const manifest = loadManifest();
const asOf = demoAsOfDate(manifest);

describe("demo manifest", () => {
	it("passes the version/hash gate with the code-side expectation", () => {
		expect(manifest.version).toBe(EXPECTED_MANIFEST_VERSION);
		expect(manifest.sha256).toBe(EXPECTED_MANIFEST_SHA256);
		expect(() => assertManifest(manifest)).not.toThrow();
		expect(manifest.demoAsOf).toBe("2026-06-30");
	});

	it("requires clock agreement with the service env", () => {
		expect(() => assertFixtureClock(manifest.demoAsOf, "2026-06-30")).not.toThrow();
		expect(() => assertFixtureClock(manifest.demoAsOf, undefined)).not.toThrow();
		expect(() => assertFixtureClock(manifest.demoAsOf, "2026-07-01")).toThrow();
	});

	it("holds at least breadtalk plus an existing demo persona", () => {
		expect(Object.keys(manifest.personas)).toEqual(
			expect.arrayContaining(["breadtalk", "alex", "sparse"]),
		);
		expect(manifest.personas.alex.newUser).toBe(false);
		expect(manifest.personas.alex.email).toBe("alex@example.com");
	});

	it("breadtalk is a valid-KYC SME with stale statement/financials", () => {
		const bt = manifest.personas.breadtalk;
		expect(bt.profile.segment).toBe("sme");
		expect(bt.profile.kycStatus).toBe("verified");
		expect(new Date(bt.profile.kycExpiresAt as string) > asOf).toBe(true);
		const stmt = bt.evidence.find((e) => e.fixtureKey === "bank_statement_stale");
		const fin = bt.evidence.find((e) => e.fixtureKey === "financial_statements_stale");
		expect(stmt?.periodEnd).toBe("2026-03-02"); // DEMO_AS_OF - 120 days
		expect(fin?.periodEnd).toBe("2024-06-30"); // DEMO_AS_OF - 24 months
		expect(statementFreshness("bank_statement", stmt?.periodEnd ?? null, asOf)).toBe("stale");
		expect(statementFreshness("financial_statements", fin?.periodEnd ?? null, asOf)).toBe("stale");
		expect(bt.case.staleCopies).toEqual(["bank_statement_stale", "financial_statements_stale"]);
		expect(bt.expectedBlockers).toEqual({
			"document:bank_statement": ["stale"],
			"document:financial_statements": ["stale"],
		});
	});

	it("breadtalk fresh variants are fresh and reuse-eligible by policy", () => {
		const bt = manifest.personas.breadtalk;
		const stmt = bt.freshEvidence.find((e) => e.fixtureKey === "bank_statement_fresh");
		const fin = bt.freshEvidence.find((e) => e.fixtureKey === "financial_statements_fresh");
		expect(statementFreshness("bank_statement", stmt?.periodEnd ?? null, asOf)).toBe("fresh");
		expect(statementFreshness("financial_statements", fin?.periodEnd ?? null, asOf)).toBe("fresh");
	});

	it("case identity matches the profile login (draft guard)", () => {
		for (const persona of Object.values(manifest.personas)) {
			expect(String(persona.case.identity.email).toLowerCase()).toBe(persona.email);
			expect(persona.case.fixtureKey).toBeTruthy();
		}
	});

	it("transaction balance chains are internally consistent", () => {
		for (const [key, persona] of Object.entries(manifest.personas)) {
			let prev: number | null = null;
			for (const txn of persona.transactions) {
				if (prev !== null) {
					expect(txn.balanceAfterCents - prev, `${key}/${txn.sourceReference}`).toBe(
						txn.amountCents,
					);
				}
				prev = txn.balanceAfterCents;
			}
			const refs = new Set(persona.transactions.map((t) => t.sourceReference));
			expect(refs.size, `${key} duplicate sourceReference`).toBe(persona.transactions.length);
		}
	});

	it("evidence PDFs are deterministic text PDFs", () => {
		for (const persona of Object.values(manifest.personas)) {
			for (const evidence of [...persona.evidence, ...persona.freshEvidence]) {
				const first = demoEvidenceBytes(evidence);
				const second = demoEvidenceBytes(evidence);
				expect(sha256Hex(first.bytes)).toBe(sha256Hex(second.bytes));
				expect(first.bytes.subarray(0, 5).toString()).toBe("%PDF-");
				expect(first.text).toContain(evidence.title);
			}
		}
		expect(demoPdfForLines("h", ["a"]).equals(demoPdfForLines("h", ["a"]))).toBe(true);
	});

	it("declares T02/T18 expectations including an insufficient-data persona", () => {
		expect(manifest.personas.breadtalk.expectedSignals).toEqual(
			expect.arrayContaining(["round_trip", "cash_deposit_share", "returned_payment"]),
		);
		expect(manifest.personas.sparse.expectedSignals).toEqual(["insufficient_data"]);
		expect(manifest.personas.alex.expectedSignals).toEqual(["revenue_concentration"]);
		expect(manifest.personas.sparse.accounts).toEqual([]);
		expect(manifest.personas.sparse.transactions).toEqual([]);
		for (const persona of Object.values(manifest.personas)) {
			for (const finding of persona.expectedFindings) {
				expect(["mismatch", "needs_chase"]).toContain(finding.status);
			}
		}
	});

	it("hash covers content (any edit changes it)", () => {
		const edited = structuredClone(manifest);
		edited.personas.breadtalk.case.amountCents += 1;
		expect(manifestHash(edited)).not.toBe(manifest.sha256);
	});
});
