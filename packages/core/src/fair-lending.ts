// US-ADV-4 fair-lending deny-list and proxy scan (pure).
//
// The list is deliberately blunt: a false positive blocks the artifact and
// surfaces for human review rather than letting a protected attribute or a
// common credit proxy reach an applicant-facing reason. Callers scan both
// generator inputs and generated prose.

export const FAIR_LENDING_DENY_LIST_VERSION = "fair-lending-v1";

const PROTECTED_TERMS = [
	"gender",
	"gender identity",
	"male",
	"female",
	"man",
	"woman",
	"sex",
	"sexual",
	"sexual orientation",
	"age",
	"ages",
	"aged",
	"years old",
	"race",
	"racial",
	"ethnicity",
	"ethnic",
	"religion",
	"religious",
	"muslim",
	"christian",
	"hindu",
	"buddhist",
	"jewish",
	"chinese",
	"malay",
	"indian",
	"eurasian",
	"caste",
	"marital",
	"married",
	"divorced",
	"single",
	"widowed",
	"nationality",
	"national origin",
	"citizenship",
	"immigration",
	"immigration status",
	"disability",
	"disabilities",
	"disabled",
	"pregnancy",
	"pregnant",
	"genetic",
	"veteran",
	"date of birth",
	"dob",
	"transgender",
	"parental status",
	"family status",
	"caregiver",
	"mother",
	"father",
] as const;

const PROXY_TERMS = [
	"postal code",
	"postcode",
	"zip code",
	"zip",
	"neighbourhood",
	"neighborhood",
	"census tract",
	"census block",
	"district",
	"redlining",
	"geography",
	"geographic",
	"residential address",
	"home address",
	"public assistance",
	"welfare",
	"source of income",
	"primary language",
	"language preference",
	"english proficiency",
] as const;

/** Underscores/hyphens are word characters for `\b`; normalise identifiers
 * so `marital_status`, `postal_code`, and `AGE_AT_APPLICATION` cannot slip past. */
export function normalizeFairLendingText(text: string): string {
	return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll(/[_\-.]+/g, " ");
}

function regexFor(terms: readonly string[]): RegExp {
	const escaped = [...terms]
		.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.sort((a, b) => b.length - a.length);
	return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
}

/** Direct protected attributes; kept as an export so the shared validator
 * and the adverse-action input scan use one list. */
export const PROTECTED_ATTRIBUTE_RE = regexFor(PROTECTED_TERMS);

/** Common credit proxies that are not direct attributes. */
export const FAIR_LENDING_PROXY_RE = regexFor(PROXY_TERMS);

export interface FairLendingScan {
	protectedAttributes: string[];
	proxies: string[];
}

function matches(re: RegExp, terms: readonly string[], normalized: string): string[] {
	if (!re.test(normalized)) return [];
	return terms.filter((term) => regexFor([term]).test(normalized));
}

/** Return the deny-list terms present in `text`; empty means clean. */
export function scanFairLending(text: string): FairLendingScan {
	const normalized = normalizeFairLendingText(text).toLowerCase();
	return {
		protectedAttributes: matches(PROTECTED_ATTRIBUTE_RE, PROTECTED_TERMS, normalized),
		proxies: matches(FAIR_LENDING_PROXY_RE, PROXY_TERMS, normalized),
	};
}
