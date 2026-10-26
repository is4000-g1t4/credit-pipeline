// Compatibility re-exports: the deterministic policy gates now live in
// @credit/core so the applications case navigator and the policy service use
// one implementation (no duplicated regexes or HMAC canonicalization).
export {
	classifyPolicyScope as classifyScope,
	containsAdvisoryActionLanguage,
	EMAIL_RE,
	hasDirectIdentifier,
	hmacQuestion,
	NRIC_RE,
	PHONE_RE,
	scrubKnownPii,
} from "@credit/core";
