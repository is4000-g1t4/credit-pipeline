import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const frontmatterSchema = z
	.object({
		policy_key: z.string().regex(/^POL-CR-\d{3}$/),
		title: z.string().min(1).max(200),
		domain: z.literal("credit"),
		policy_family: z.enum([
			"underwriting",
			"affordability",
			"documentation",
			"exceptions",
			"pricing",
			"servicing",
		]),
		product_scope: z.enum(["individual", "sme", "all"]),
		jurisdiction: z.string().regex(/^[A-Z]{2}$/),
		version: z.string().regex(/^v\d+(\.\d+)?$/),
		owner_email: z.email(),
		effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	})
	.strict();

export type PolicyFrontmatter = z.infer<typeof frontmatterSchema>;

export interface ParsedPolicySection {
	sectionId: string;
	heading: string;
	body: string;
	orderIndex: number;
	charStart: number;
	charEnd: number;
	contentHash: string;
}

export interface ParsedPolicy {
	frontmatter: PolicyFrontmatter;
	sections: ParsedPolicySection[];
	contentHash: string;
	sourceUri: string;
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseFrontmatter(source: string): { raw: Record<string, string>; bodyStart: number } {
	if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
		throw new Error("policy file must start with YAML frontmatter");
	}
	const newline = source.startsWith("---\r\n") ? 5 : 4;
	const end = source.indexOf("\n---", newline);
	if (end === -1) throw new Error("policy frontmatter is not closed");
	const block = source.slice(newline, end);
	const raw: Record<string, string> = {};
	for (const line of block.split(/\r?\n/)) {
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		const match = /^([a-z_]+):\s*(.*)$/.exec(line);
		if (!match) throw new Error(`invalid frontmatter line: ${line}`);
		const key = match[1] as string;
		let value = (match[2] as string).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key in raw) throw new Error(`duplicate frontmatter key: ${key}`);
		raw[key] = value;
	}
	const after = source.indexOf("\n", end + 1);
	const bodyStart = after === -1 ? source.length : after + 1;
	return { raw, bodyStart };
}

const SECTION_RE = /^##[ \t]+(.+?)[ \t]+\{#([^}\s]+)\}[ \t]*$/gm;

/** Parse canonical Markdown. Every `##` section must carry a unique
 * `{#section-id}` anchor; a missing/duplicate anchor fails the import. */
export function parsePolicyMarkdown(source: string, sourceUri = "policy.md"): ParsedPolicy {
	const { raw } = parseFrontmatter(source);
	const frontmatter = frontmatterSchema.parse(raw);
	const matches = [...source.matchAll(SECTION_RE)];
	if (matches.length === 0) throw new Error("policy has no anchored sections");
	const seen = new Set<string>();
	const sections: ParsedPolicySection[] = [];
	for (let i = 0; i < matches.length; i++) {
		const match = matches[i]!;
		const index = match.index ?? 0;
		const heading = (match[1] ?? "").trim();
		const sectionId = (match[2] ?? "").trim();
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sectionId)) {
			throw new Error(`invalid section id: ${sectionId}`);
		}
		if (seen.has(sectionId)) throw new Error(`duplicate section id: ${sectionId}`);
		seen.add(sectionId);
		const bodyStartAt = index + match[0].length;
		const bodyEnd =
			i + 1 < matches.length ? (matches[i + 1]!.index ?? source.length) : source.length;
		const body = source.slice(bodyStartAt, bodyEnd).trim();
		if (body.length === 0) throw new Error(`section ${sectionId} has no body`);
		if (/^##[ \t]+/m.test(body)) {
			throw new Error(`section ${sectionId} has an unanchored heading`);
		}
		sections.push({
			sectionId,
			heading,
			body,
			orderIndex: i,
			charStart: bodyStartAt,
			charEnd: bodyEnd,
			contentHash: sha256(`${heading}\n${body}`),
		});
	}
	return {
		frontmatter,
		sections,
		contentHash: sha256(source),
		sourceUri: sourceUri || `policy:${frontmatter.policy_key}`,
	};
}

export function readPolicyDir(dir: string): ParsedPolicy[] {
	const files = readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.sort();
	return files.map((name) => parsePolicyMarkdown(readFileSync(join(dir, name), "utf8"), name));
}
