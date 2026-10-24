import { createHmac } from "node:crypto";

const OUT_OF_SCOPE = [
	"aml",
	"anti-money",
	"money laundering",
	"sanction",
	"kyc",
	"know your customer",
	"identity verification",
	"privacy",
	"gdpr",
	"pdpa",
	"information security",
	"infosec",
	"cyber",
	"hr",
	"human resources",
	"employee",
	"conduct",
	"complaint",
	"procurement",
	"vendor",
	"esg",
	"sustainability",
	"tax",
	"accounting",
	"operational risk",
];

const CREDIT_TERMS = [
	"credit",
	"loan",
	"underwriting",
	"affordability",
	"dscr",
	"income",
	"debt",
	"obligation",
	"document",
	"exception",
	"pricing",
	"rate",
	"servicing",
	"repayment",
	"arrears",
	"collateral",
	"guarantee",
	"policy",
	"sme",
	"individual",
];

/** Deterministic scope gate. Ambiguous credit questions proceed to
 * retrieval; an explicit out-of-domain question with no credit term does not
 * call the embedder/answerer. */
export function classifyScope(question: string): "credit" | "out_of_scope" {
	const q = question.toLowerCase();
	const hasCredit = CREDIT_TERMS.some((term) => q.includes(term));
	const hasOut = OUT_OF_SCOPE.some((term) => q.includes(term));
	if (hasOut && !hasCredit) return "out_of_scope";
	return "credit";
}

export const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
export const NRIC_RE = /\b[STFGM]\d{7}[A-Z]\b/i;
export const PHONE_RE = /(?:\+?65[\s-]?)?[689]\d{3}[\s-]?\d{4}\b/;
const LONG_ID_RE = /\b(?:\d[ -]?){10,19}\b/;

/** Direct identifiers must never reach the embedding provider. */
export function hasDirectIdentifier(question: string): boolean {
	return (
		EMAIL_RE.test(question) ||
		NRIC_RE.test(question) ||
		PHONE_RE.test(question) ||
		LONG_ID_RE.test(question)
	);
}

export function hmacQuestion(secret: string, question: string): string {
	return createHmac("sha256", secret).update(question.trim()).digest("hex");
}
