// case_brief prompt templates. Case facts travel in a delimited <case_facts> block
// with a system instruction that they are data only (untrusted input).
// `purpose` is never sent. promptHash = SHA-256 of the exact templates.
import { createHash } from "node:crypto";
import { loadInstructions } from "@credit/agent-kit";

export const AGENT_VERSION = "1.0.0";
export const PROMPT_VERSION = "v7";

/** Static system prompt: `instructions.md` (byte-exact; see prompt.test.ts). */
export const SYSTEM_TEMPLATE = loadInstructions(import.meta.url);

export const USER_TEMPLATE = `<case_facts>
applicant: {{APPLICANT}}
company: {{COMPANY}}
registration_number: {{REGISTRATION_NUMBER}}
city: {{CITY}}
industry: {{INDUSTRY}}
years_trading: {{YEARS_TRADING}}
product: {{PRODUCT}}
amount_cents: {{AMOUNT_CENTS}}
term_months: {{TERM_MONTHS}}
as_of: {{AS_OF}}
</case_facts>

Research the entity above as of {{AS_OF}}. Use search_sources for the relevant categories, fetch the most relevant results, then return the brief as structured output.`;

export interface PromptCaseFacts {
	applicantName: string;
	companyName: string | null;
	registrationNumber: string | null;
	city: string | null;
	industry: string | null;
	yearsTrading: number | null;
	product: string;
	amountCents: number;
	termMonths: number;
	asOf: string;
}

function fill(template: string, values: Record<string, string>): string {
	return template.replace(/{{([A-Z_]+)}}/g, (_m, key: string) => values[key] ?? "");
}

/** Escape one case-fact value so it cannot close <case_facts> or inject
 * instructions: `<`, `>`, backticks become unicode escapes, backslashes
 * double, CR/LF become the two chars `\n`. Numbers are already safe. */
export function escapeCaseFactValue(v: string): string {
	return v
		.replace(/\\/g, "\\\\")
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/`/g, "\\u0060")
		.replace(/\r\n|\r|\n/g, "\\n");
}

const str = (v: string | null): string => (v === null ? "" : escapeCaseFactValue(v));
const num = (v: number | null): string => (v === null ? "" : String(v));

export function buildUserPrompt(facts: PromptCaseFacts): string {
	return fill(USER_TEMPLATE, {
		APPLICANT: escapeCaseFactValue(facts.applicantName),
		COMPANY: str(facts.companyName),
		REGISTRATION_NUMBER: str(facts.registrationNumber),
		CITY: str(facts.city),
		INDUSTRY: str(facts.industry),
		YEARS_TRADING: num(facts.yearsTrading),
		PRODUCT: escapeCaseFactValue(facts.product),
		AMOUNT_CENTS: String(facts.amountCents),
		TERM_MONTHS: String(facts.termMonths),
		AS_OF: escapeCaseFactValue(facts.asOf),
	});
}

/** SHA-256 of the exact system+user templates (placeholders unfilled). */
export function promptHash(): string {
	return createHash("sha256").update(`${SYSTEM_TEMPLATE}\n${USER_TEMPLATE}`, "utf8").digest("hex");
}
