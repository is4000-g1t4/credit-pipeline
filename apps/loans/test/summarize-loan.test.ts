// summarizeLoan unit test (compose-free): the list/detail/internal shapes
// carry the same serialized fields — no DB.
import type { loans } from "@credit/db/loans";
import { describe, expect, it } from "vitest";
import { summarizeLoan } from "../src/routes/loans.js";

function row(): typeof loans.$inferSelect {
	return {
		id: "22222222-2222-4222-8222-222222222222",
		applicationId: "33333333-3333-4333-8333-333333333333",
		applicationReference: "APP-2026-1",
		applicantUserId: "user-1",
		product: "personal_loan",
		principalCents: 1200000,
		termMonths: 48,
		rateBps: 650,
		monthlyPaymentCents: 28458,
		status: "active",
		outstandingCents: 900000,
		nextDueDate: "2026-11-19",
		disbursedAt: new Date("2026-10-01T00:00:00.000Z"),
	} as typeof loans.$inferSelect;
}

describe("summarizeLoan", () => {
	it("serializes the public loan shape", () => {
		expect(summarizeLoan(row())).toEqual({
			id: "22222222-2222-4222-8222-222222222222",
			applicationId: "33333333-3333-4333-8333-333333333333",
			reference: "APP-2026-1",
			principalCents: 1200000,
			termMonths: 48,
			rateBps: 650,
			monthlyPaymentCents: 28458,
			status: "active",
			outstandingCents: 900000,
			nextDueDate: "2026-11-19",
			disbursedAt: "2026-10-01T00:00:00.000Z",
		});
	});
});
