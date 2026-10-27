// Compatibility surface: the token lives in @credit/core so the research
// service can import it without crossing into this app's source tree.
export {
	signCaseToken,
	verifyCaseToken,
	type CaseTokenClaims,
	type CaseTokenInput,
} from "@credit/core";
