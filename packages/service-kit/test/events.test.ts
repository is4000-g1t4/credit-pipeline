import { describe, expect, it } from "vitest";
import type { Tx } from "@credit/db/shared";
import { writeAudit } from "../src/events.js";

const tx = {
	insert: () => ({ values: async () => undefined }),
} as unknown as Tx;

const base = {
	actor: "officer",
	action: "integrity.test",
	entity: "document_integrity_run",
};

describe("writeAudit PII blocklist", () => {
	it("rejects document text, quotes, values, and notes in any key casing", async () => {
		for (const key of [
			"quote",
			"value",
			"text",
			"note",
			"pageText",
			"producer",
			"creator",
			"accountNumber",
			"accountHolderName",
			"resolutionNote",
			"candidateValue",
			"leftValue",
			"rightValue",
			"leftQuote",
			"explanation",
		]) {
			await expect(writeAudit(tx, { ...base, payload: { [key]: "sensitive" } })).rejects.toThrow(
				/PII key/,
			);
		}
	});

	it("allows ids, codes, counts, and versions", async () => {
		await expect(
			writeAudit(tx, {
				...base,
				payload: {
					runId: "11111111-1111-4111-8111-111111111111",
					errorCode: "TIMEOUT",
					count: 3,
					model: "deepseek/deepseek-v4.1-flash-1017",
					promptVersion: "integrity-triage-v1",
					agentVersion: "integrity-agent-v1",
				},
			}),
		).resolves.toBeUndefined();
	});
});
