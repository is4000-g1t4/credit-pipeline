import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { defineAgent } from "../src/define.js";
import { loadInstructions, renderInstructions } from "../src/instructions.js";

describe("loadInstructions", () => {
	it("returns the file minus exactly one trailing newline", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-kit-"));
		writeFileSync(join(dir, "instructions.md"), "line one\n\nline two\n\n");
		const url = pathToFileURL(join(dir, "agent.ts"));
		expect(loadInstructions(url)).toBe("line one\n\nline two\n");
	});
});

describe("renderInstructions", () => {
	it("fills placeholders", () => {
		expect(
			renderInstructions("as of {{asOf}}, cap {{cap}}", { asOf: "2026-01-01", cap: "3" }),
		).toBe("as of 2026-01-01, cap 3");
	});
	it("throws on missing or unused variables", () => {
		expect(() => renderInstructions("{{a}}", {})).toThrow("{{a}}");
		expect(() => renderInstructions("x", { a: "1" })).toThrow("not used: a");
	});
});

describe("defineAgent", () => {
	it("freezes and validates the name", () => {
		const def = defineAgent({
			name: "case-brief",
			owner: "research",
			description: "d",
			model: { env: "AGENT_MODEL", default: "m" },
			flags: ["AGENTS_ENABLED"],
			versions: { prompt: "p1" },
			tools: [],
			execution: "temporal",
		});
		expect(Object.isFrozen(def)).toBe(true);
		expect(() => defineAgent({ ...def, name: "Bad Name" })).toThrow("kebab-case");
	});
});
