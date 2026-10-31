// bookLoan step (a) insert race: the decision insert hits ON CONFLICT DO
// NOTHING (another writer inserted between our read and insert). The winner
// row is re-read; a declined winner, or an officer winner from a different
// request, must throw DecisionConflict and never reach the loan step.
// The race window cannot be forced on real Postgres (the application row
// lock serializes bookLoan callers), so the transaction is stubbed.
import { decisions } from "@credit/db/applications";
import { beforeEach, describe, expect, it, vi } from "vitest";

const APP_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

interface FakeTx {
	selectResults: unknown[][];
	inserts: unknown[];
}

const state = vi.hoisted(() => ({
	apps: null as unknown,
	loans: null as unknown,
	withTxDbs: [] as unknown[],
}));

function fakeTx(selectResults: unknown[][]): FakeTx & Record<string, unknown> {
	const tx: FakeTx & Record<string, unknown> = {
		selectResults,
		inserts: [],
		select: () => ({
			from: () => ({
				where: () => {
					const rows = Promise.resolve(tx.selectResults.shift() ?? []);
					return Object.assign(rows, { for: () => rows });
				},
			}),
		}),
		insert: (table: unknown) => {
			tx.inserts.push(table);
			return {
				values: () => ({
					onConflictDoNothing: () => ({ returning: async () => [] }),
					returning: async () => [],
				}),
			};
		},
		update: () => {
			throw new Error("unexpected update");
		},
	};
	return tx;
}

vi.mock("../src/db.js", () => ({
	getApplicationsDb: () => ({ db: state.apps }),
	getLoansDb: () => ({ db: state.loans }),
}));

vi.mock("@credit/db/applications", async (importOriginal) => ({
	...(await importOriginal<typeof import("@credit/db/applications")>()),
	withTx: async (db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
		state.withTxDbs.push(db);
		return fn(db);
	},
}));

vi.mock("../src/activities/shared.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/activities/shared.js")>()),
	loadCreditContext: async () => ({
		app: {
			id: APP_ID,
			reference: "APP-2026-RACE01",
			type: "individual",
			product: "personal_loan",
			status: "processing",
			amountCents: 800_000,
			termMonths: 36,
			financial: { monthlyIncomeCents: 600_000, existingDebtCents: 0 },
			business: null,
		},
		score: 720,
		grade: "B",
		factors: [],
		newPaymentCents: 26_000,
		policyInputs: {},
		policyReasons: [],
	}),
}));

const { bookLoan } = await import("../src/activities/booking.js");

describe("bookLoan decision insert race", () => {
	beforeEach(() => {
		state.withTxDbs = [];
	});

	it.each([
		{
			name: "auto route, declined winner",
			input: { applicationId: APP_ID, route: "auto" as const },
			status: "processing",
			winner: { id: "d-1", outcome: "declined", requestId: null },
		},
		{
			name: "officer route, same request but declined winner",
			input: {
				applicationId: APP_ID,
				route: "officer" as const,
				requestId: REQUEST_ID,
				officerUserId: "officer-1",
			},
			status: "pending_review",
			winner: { id: "d-1", outcome: "declined", requestId: REQUEST_ID },
		},
		{
			name: "officer route, approved winner from another request",
			input: {
				applicationId: APP_ID,
				route: "officer" as const,
				requestId: REQUEST_ID,
				officerUserId: "officer-1",
			},
			status: "pending_review",
			winner: {
				id: "d-1",
				outcome: "approved",
				requestId: "123e4567-e89b-42d3-a456-426614174999",
			},
		},
	])("$name: throws DecisionConflict and books nothing", async ({ input, status, winner }) => {
		const appsTx = fakeTx([
			[{ id: APP_ID, reference: "APP-2026-RACE01", status }], // FOR UPDATE lock
			[], // no decision yet
			[winner], // re-read after the insert returned nothing
		]);
		const loansTx = fakeTx([]);
		state.apps = appsTx;
		state.loans = loansTx;

		await expect(bookLoan(input)).rejects.toMatchObject({ type: "DecisionConflict" });

		// Only the losing decision insert was attempted: no audit/outbox rows.
		expect(appsTx.inserts).toEqual([decisions]);
		// The loan step never ran.
		expect(state.withTxDbs).toEqual([appsTx]);
		expect(loansTx.inserts).toEqual([]);
	});
});
