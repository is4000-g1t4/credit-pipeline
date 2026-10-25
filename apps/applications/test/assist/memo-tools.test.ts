// runMemoEvidenceTool unit tests: pure function, no DB, no network.
import { describe, expect, it } from "vitest";
import type { EvidenceBundle, EvidenceItem } from "@credit/core";
import {
	getEvidenceParams,
	listEvidenceParams,
	listUnavailableParams,
	MEMO_TOOL_NAMES,
	runMemoEvidenceTool,
	searchEvidenceParams,
} from "../../src/assist/memo-tools.js";

const APP_ID = "55555555-5555-4555-8555-555555555555";

function item(
	ref: string,
	sourceType: EvidenceItem["sourceType"],
	label: string,
	content: string,
): EvidenceItem {
	return {
		ref,
		sourceType,
		label,
		content,
		access: { retentionUntil: null, legalHold: false },
		metadata: {},
	};
}

function bundle(): EvidenceBundle {
	return {
		applicationId: APP_ID,
		asOf: "2026-06-30T00:00:00.000Z",
		assembledAt: "2026-06-30T01:00:00.000Z",
		items: [
			item(`case_fact:${APP_ID}:amountCents`, "case_fact", "amountCents", "6000000"),
			item(`case_fact:${APP_ID}:product`, "case_fact", "product", "sme_term_loan"),
			item("score_reason:s:BANK_RELATIONSHIP", "score_reason", "factor", "BANK_RELATIONSHIP +40"),
			item("policy:POL-CR-002:4.2", "policy_section", "policy", "Coverage must stay above 1.25x."),
		],
		unavailable: [{ ref: "document:d:p9:0-5", sourceType: "document", code: "missing" }],
	};
}

describe("runMemoEvidenceTool", () => {
	it("exposes exactly the four allowlisted tools", () => {
		expect([...MEMO_TOOL_NAMES]).toEqual([
			"list_evidence",
			"search_evidence",
			"get_evidence",
			"list_unavailable",
		]);
	});

	it("lists evidence refs with short excerpts", () => {
		const outcome = runMemoEvidenceTool("list_evidence", {}, bundle());
		expect(outcome.resultCount).toBe(4);
		expect(outcome.payload).toMatchObject({ total: 4 });
		expect(outcome.sourceTypes).toEqual(["case_fact", "policy_section", "score_reason"]);
		expect(outcome.refs).toHaveLength(4);
		const items = (outcome.payload as { items: Array<{ excerpt: string }> }).items;
		expect(items.every((i) => i.excerpt.length <= 300)).toBe(true);
		expect(JSON.stringify(outcome.payload)).toContain("6000000");
	});

	it("filters listings by source type and caps the limit", () => {
		const filtered = runMemoEvidenceTool("list_evidence", { sourceType: "case_fact" }, bundle());
		expect(filtered.resultCount).toBe(2);
		expect(filtered.sourceTypes).toEqual(["case_fact"]);
		const capped = runMemoEvidenceTool("list_evidence", { limit: 1 }, bundle());
		expect(capped.resultCount).toBe(1);
		expect((capped.payload as { total: number }).total).toBe(4);
	});

	it("rejects unknown source types as a tool error", () => {
		const outcome = runMemoEvidenceTool("list_evidence", { sourceType: "ledger" }, bundle());
		expect(outcome.resultCount).toBe(0);
		expect(outcome.payload).toMatchObject({ error: "unknown sourceType" });
	});

	it("searches tokens case-insensitively and caps excerpts", () => {
		const outcome = runMemoEvidenceTool(
			"search_evidence",
			{ query: "BANK relationship" },
			bundle(),
		);
		expect(outcome.resultCount).toBe(1);
		expect(outcome.refs).toEqual(["score_reason:s:BANK_RELATIONSHIP"]);
		const excerpt = (outcome.payload as { items: Array<{ excerpt: string }> }).items[0]?.excerpt;
		expect(excerpt?.length).toBeLessThanOrEqual(500);
	});

	it("requires a query and filters searches by source type", () => {
		expect(runMemoEvidenceTool("search_evidence", {}, bundle()).payload).toMatchObject({
			error: "query is required",
		});
		expect(
			runMemoEvidenceTool("search_evidence", { query: "   " }, bundle()).payload,
		).toMatchObject({ error: "query is required" });
		const filtered = runMemoEvidenceTool(
			"search_evidence",
			{ query: "6000000", sourceType: "policy_section" },
			bundle(),
		);
		expect(filtered.resultCount).toBe(0);
	});

	it("returns one capped item for get_evidence", () => {
		const long = `x`.repeat(5_000);
		const evidence: EvidenceBundle = {
			...bundle(),
			items: [item("case_fact:a:long", "case_fact", "long", long)],
		};
		const outcome = runMemoEvidenceTool("get_evidence", { ref: "case_fact:a:long" }, evidence);
		expect(outcome.resultCount).toBe(1);
		expect(outcome.sourceTypes).toEqual(["case_fact"]);
		expect(outcome.refs).toEqual(["case_fact:a:long"]);
		expect((outcome.payload as { content: string }).content).toHaveLength(4_000);
	});

	it("reports unknown or missing refs as tool errors", () => {
		expect(runMemoEvidenceTool("get_evidence", { ref: "nope" }, bundle()).payload).toMatchObject({
			error: "unknown evidence ref",
		});
		expect(runMemoEvidenceTool("get_evidence", {}, bundle()).payload).toMatchObject({
			error: "ref is required",
		});
	});

	it("lists unavailable sources with typed refs", () => {
		const outcome = runMemoEvidenceTool("list_unavailable", {}, bundle());
		expect(outcome.resultCount).toBe(1);
		expect(outcome.refs).toEqual(["document:d:p9:0-5"]);
		expect(outcome.sourceTypes).toEqual(["document"]);
		const empty: EvidenceBundle = { ...bundle(), unavailable: [] };
		expect(runMemoEvidenceTool("list_unavailable", {}, empty).resultCount).toBe(0);
	});

	it("rejects unknown tool names as tool errors", () => {
		const outcome = runMemoEvidenceTool("mystery_tool", {}, bundle());
		expect(outcome.resultCount).toBe(0);
		expect(outcome.sourceTypes).toEqual([]);
		expect(JSON.stringify(outcome.payload)).toContain("unknown tool");
	});

	it("validates the zod parameter schemas strictly", () => {
		expect(listEvidenceParams.safeParse({ sourceType: "case_fact", limit: 5 }).success).toBe(true);
		expect(listEvidenceParams.safeParse({ sourceType: "ledger" }).success).toBe(false);
		expect(listEvidenceParams.safeParse({ limit: 99 }).success).toBe(false);
		expect(searchEvidenceParams.safeParse({ query: "x" }).success).toBe(true);
		expect(searchEvidenceParams.safeParse({}).success).toBe(false);
		expect(getEvidenceParams.safeParse({ ref: "r" }).success).toBe(true);
		expect(getEvidenceParams.safeParse({}).success).toBe(false);
		expect(listUnavailableParams.safeParse({}).success).toBe(true);
		expect(listUnavailableParams.safeParse({ extra: 1 }).success).toBe(false);
	});
});
