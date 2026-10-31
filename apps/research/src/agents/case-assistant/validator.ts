// The case-assistant answer validator: a blocking gate between the model's
// prose and the officer. Advisory language and direct identifiers fail
// UNSAFE_OUTPUT; empty or oversized answers fail INVALID_OUTPUT. It is code,
// never model output, that decides whether an answer may be shown.
import {
	advisoryActionMatch,
	containsAdvisoryActionLanguage,
	hasDirectIdentifier,
} from "@credit/core";
import { CaseAssistantError } from "./types.js";

export const MAX_ASSISTANT_ANSWER_CHARS = 4000;

const KNOWN_NAME_MIN_CHARS = 3;

/** Blocking answer validator: advisory/PII leaks fail UNSAFE, shape fails INVALID. */
export function validateCaseAssistantAnswer(
	answer: unknown,
	caseFacts: Record<string, unknown>,
): asserts answer is string {
	if (typeof answer !== "string" || answer.trim().length === 0) {
		throw new CaseAssistantError("INVALID_OUTPUT", "assistant answer is empty");
	}
	if (answer.length > MAX_ASSISTANT_ANSWER_CHARS) {
		throw new CaseAssistantError("INVALID_OUTPUT", "assistant answer exceeds the length limit");
	}
	if (containsAdvisoryActionLanguage(answer)) {
		const term = advisoryActionMatch(answer) ?? "advisory";
		throw new CaseAssistantError(
			"UNSAFE_OUTPUT",
			`assistant answer contains advisory language (${term})`,
		);
	}
	if (hasDirectIdentifier(answer)) {
		throw new CaseAssistantError("UNSAFE_OUTPUT", "assistant answer contains a direct identifier");
	}
	const known = [caseFacts["applicantName"]]
		.filter((v): v is string => typeof v === "string")
		.map((v) => v.trim())
		.filter((v) => v.length >= KNOWN_NAME_MIN_CHARS);
	const lowered = answer.toLowerCase();
	for (const name of known) {
		if (lowered.includes(name.toLowerCase())) {
			throw new CaseAssistantError("UNSAFE_OUTPUT", "assistant answer repeats a case name");
		}
	}
}
