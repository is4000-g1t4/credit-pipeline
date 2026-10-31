// eve-style `instructions.md` loading. An agent directory keeps its static
// system prompt in `instructions.md`; `agent.ts` loads it once at module
// init with `loadInstructions(import.meta.url)`.
//
// Byte contract: the returned text is the file content with exactly one
// trailing "\n" removed (editors and the formatter always add one). Prompt
// versions are pinned on traces, so moving a prompt into a file must keep
// the string identical — instructions.md files are excluded from oxfmt.
//
// Templating: `{{name}}` placeholders, filled by `renderInstructions`.
// Missing or unused variables throw, so a renamed placeholder can't
// silently ship a prompt with a literal `{{...}}` in it.
import { readFileSync } from "node:fs";

export function loadInstructions(moduleUrl: string | URL, file = "instructions.md"): string {
	const text = readFileSync(new URL(file, moduleUrl), "utf8");
	return text.endsWith("\n") ? text.slice(0, -1) : text;
}

const PLACEHOLDER = /\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g;

export function renderInstructions(template: string, vars: Record<string, string>): string {
	const used = new Set<string>();
	const out = template.replace(PLACEHOLDER, (_m, name: string) => {
		const value = vars[name];
		if (value === undefined) throw new Error(`instructions placeholder {{${name}}} has no value`);
		used.add(name);
		return value;
	});
	const unused = Object.keys(vars).filter((k) => !used.has(k));
	if (unused.length > 0) throw new Error(`instructions variables not used: ${unused.join(", ")}`);
	return out;
}
