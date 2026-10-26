import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	POLICY_ENGINE_STANDARD_HASH,
	POLICY_RULE_DEFINITIONS,
	hashCanonical,
	validateRegistryRefs,
} from "@credit/core";
import { parsePolicyMarkdown } from "../src/markdown.js";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const POLICY_DIR = join(HERE, "policies", "credit");

function loadCorpus() {
	const files = readdirSync(POLICY_DIR)
		.filter((name) => name.endsWith(".md"))
		.sort();
	const parsed = files.map((file) =>
		parsePolicyMarkdown(readFileSync(join(POLICY_DIR, file), "utf8"), file),
	);
	const corpus = parsed.flatMap((p) =>
		p.sections.map((section) => ({
			policyKey: p.frontmatter.policy_key,
			sectionId: section.sectionId,
			productScope: p.frontmatter.product_scope,
		})),
	);
	return { parsed, corpus };
}

describe("policy registry corpus", () => {
	it("every registry ref exists and matches scope for both kinds", () => {
		const { corpus } = loadCorpus();
		const refs = new Set(corpus.map((s) => `${s.policyKey}#${s.sectionId}`));
		for (const kind of ["individual", "sme"] as const) {
			const v = validateRegistryRefs(refs, corpus, kind, true);
			expect(v.missingRefs).toEqual([]);
			expect(v.scopeMismatches).toEqual([]);
			expect(v.missingExceptionRuleIds).toEqual([]);
		}
		// 19 definitions, no duplicates.
		expect(POLICY_RULE_DEFINITIONS).toHaveLength(19);
		expect(new Set(POLICY_RULE_DEFINITIONS.map((d) => d.ruleId)).size).toBe(19);
	});

	it("9.0-9.4 bodies hash to POLICY_ENGINE_STANDARD_HASH", () => {
		const { parsed } = loadCorpus();
		const std = parsed.find((p) => p.frontmatter.policy_key === "POL-CR-009");
		expect(std).toBeDefined();
		const bodies = std!.sections
			.filter((s) => ["9.0", "9.1", "9.2", "9.3", "9.4"].includes(s.sectionId))
			.map((s) => ({ sectionId: s.sectionId, body: s.body }))
			.sort((a, b) => (a.sectionId < b.sectionId ? -1 : 1));
		expect(bodies).toHaveLength(5);
		expect(hashCanonical(bodies)).toBe(POLICY_ENGINE_STANDARD_HASH);
	});

	it("9.x states the engine constants", () => {
		const { parsed } = loadCorpus();
		const std = parsed.find((p) => p.frontmatter.policy_key === "POL-CR-009")!;
		const combined = std.sections.map((s) => s.body).join("\n");
		for (const needle of [
			"700",
			"580",
			"50%",
			"55%",
			"1.5x",
			"1.0x",
			"S$15,000",
			"S$25,000",
			"S$50,000",
			"S$100,000",
		]) {
			expect(combined).toContain(needle);
		}
	});
});
