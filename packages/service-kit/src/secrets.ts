// Production secret hygiene: with NODE_ENV=production every HMAC/session
// secret must be present, at least 32 chars, not a known dev default and not a
// `change-me` placeholder. Outside production the dev defaults keep working.
// Errors name the variable only — never the value.

export const MIN_PRODUCTION_SECRET_LENGTH = 32;

/** Dev/test defaults that ship in code, docs, compose or fixtures. */
const KNOWN_DEV_SECRETS: ReadonlySet<string> = new Set([
	"dev-internal-secret",
	"dev-policy-internal-secret",
	"dev-policy-case-token-secret",
	"dev-policy-citation-secret",
	"dev-policy-audit-secret",
	"dev-policy-rule-context-secret",
]);

export interface ProductionSecretOptions {
	nodeEnv?: string | undefined;
	/** Names that may be absent (optional features). Present values are still checked. */
	optional?: readonly string[];
}

/** Returns the problems found (variable name + reason), never values. */
export function findWeakSecrets(
	secrets: Record<string, string | undefined | null>,
	optional: readonly string[] = [],
): string[] {
	const problems: string[] = [];
	for (const [name, value] of Object.entries(secrets)) {
		if (value === undefined || value === null || value === "") {
			if (!optional.includes(name)) problems.push(`${name} is missing`);
		} else if (value.length < MIN_PRODUCTION_SECRET_LENGTH) {
			problems.push(`${name} is shorter than ${MIN_PRODUCTION_SECRET_LENGTH} characters`);
		} else if (KNOWN_DEV_SECRETS.has(value)) {
			problems.push(`${name} is a known development default`);
		} else if (value.toLowerCase().startsWith("change-me")) {
			problems.push(`${name} is a change-me placeholder`);
		}
	}
	return problems;
}

/** Throws at startup in production when any listed secret is weak. No-op elsewhere. */
export function assertProductionSecrets(
	secrets: Record<string, string | undefined | null>,
	options: ProductionSecretOptions = {},
): void {
	// Normalized so "Production" or " production" cannot slip past the check.
	if (options.nodeEnv?.trim().toLowerCase() !== "production") return;
	const problems = findWeakSecrets(secrets, options.optional);
	if (problems.length > 0) {
		throw new Error(`Refusing to start in production with weak secrets: ${problems.join("; ")}`);
	}
}
