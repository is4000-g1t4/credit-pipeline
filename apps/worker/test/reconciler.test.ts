// Reconciler unit tests (compose-free): every describe outcome (RUNNING,
// CLOSED, NOT_FOUND, describe-error skip), AlreadyStarted recording, and
// the never-overwrite-terminal guard — via injected fakes through the
// reconcileOnce seam.

import { describe, expect, it, vi } from "vitest";
import {
	type DescribeState,
	ENDED_WITHOUT_DECISION,
	type ReconcilerApp,
	type ReconcilerStore,
	reconcileOnce,
	type StartOutcome,
} from "../src/reconciler.js";

interface FakeApp extends ReconcilerApp {
	failedReason: string | null;
}

function app(overrides: Partial<FakeApp> & { id: string }): FakeApp {
	const at = new Date("2026-10-19T12:00:00.000Z");
	return {
		status: "submitted",
		submittedAt: at,
		updatedAt: at,
		workflowStartedAt: null,
		failedReason: null,
		...overrides,
	};
}

const NOW = new Date("2026-10-19T12:00:00.000Z");
const OLD = new Date("2026-10-19T11:00:00.000Z"); // >30s and >15min stale
const FRESH = new Date("2026-10-19T11:59:50.000Z"); // 10s ago: within grace

function makeStore(
	initial: FakeApp[],
	decided: string[] = [],
	opts: { repair?: boolean | "throw" } = {},
) {
	const decidedSet = new Set(decided);
	const apps = new Map(initial.map((a) => [a.id, { ...a }]));
	const has = (id: string) => decidedSet.has(id);
	const guardFailed = (a: FakeApp) =>
		!["submitted", "processing", "pending_review"].includes(a.status) || has(a.id);
	const repaired: string[] = [];
	return {
		apps,
		repaired,
		async listSubmittedUnstarted(cutoff: Date) {
			return [...apps.values()].filter(
				(a) => a.status === "submitted" && a.workflowStartedAt === null && a.submittedAt < cutoff,
			);
		},
		async listSubmittedStarted() {
			return [...apps.values()].filter(
				(a) => a.status === "submitted" && a.workflowStartedAt !== null,
			);
		},
		async listStaleActive(cutoff: Date) {
			return [...apps.values()].filter(
				(a) => (a.status === "processing" || a.status === "pending_review") && a.updatedAt < cutoff,
			);
		},
		async markWorkflowStarted(id: string, now: Date) {
			const a = apps.get(id);
			if (a && a.workflowStartedAt === null) a.workflowStartedAt = now;
		},
		async hasDecisionOrLoan(id: string) {
			return has(id);
		},
		async markFailed(id: string, reason: string) {
			const a = apps.get(id);
			if (!a || guardFailed(a)) return false;
			a.status = "failed";
			a.failedReason = reason;
			return true;
		},
		async markExpired(id: string) {
			const a = apps.get(id);
			if (a?.status !== "pending_review" || has(id)) return false;
			a.status = "expired";
			return true;
		},
		async repairBooking(id: string) {
			if (opts.repair === "throw") throw new Error("saga exploded");
			repaired.push(id);
			return opts.repair ?? true;
		},
	} satisfies ReconcilerStore & { apps: Map<string, FakeApp>; repaired: string[] };
}

function fakes() {
	return {
		started: [] as string[],
		described: [] as string[],
		describe: vi.fn(async (_workflowId: string): Promise<DescribeState> => "RUNNING"),
		startWorkflow: vi.fn(async (_applicationId: string): Promise<StartOutcome> => "started"),
	};
}

describe("reconcileOnce", () => {
	it("(a) starts stale unstarted submissions and records started_at", async () => {
		const store = makeStore([
			app({ id: "old", submittedAt: OLD, updatedAt: OLD }),
			app({ id: "fresh", submittedAt: FRESH, updatedAt: FRESH }),
		]);
		const f = fakes();
		f.startWorkflow.mockImplementation(async (id: string) => {
			f.started.push(id);
			return "started";
		});

		const counts = await reconcileOnce({
			now: NOW,
			store,
			describe: f.describe,
			startWorkflow: f.startWorkflow,
		});

		expect(counts).toMatchObject({ started: 1, alreadyStarted: 0 });
		expect(f.started).toEqual(["old"]);
		expect(store.apps.get("old")?.workflowStartedAt).toEqual(NOW);
		expect(store.apps.get("fresh")?.workflowStartedAt).toBeNull();
	});

	it("(a) AlreadyStarted still records started_at", async () => {
		const store = makeStore([app({ id: "old", submittedAt: OLD, updatedAt: OLD })]);
		const f = fakes();
		f.startWorkflow.mockResolvedValue("already");

		const counts = await reconcileOnce({
			now: NOW,
			store,
			describe: f.describe,
			startWorkflow: f.startWorkflow,
		});

		expect(counts).toMatchObject({ started: 0, alreadyStarted: 1 });
		expect(store.apps.get("old")?.workflowStartedAt).toEqual(NOW);
	});

	it("(b) CLOSED with no decision fails; RUNNING/NOT_FOUND-with-decision untouched", async () => {
		const startedAt = new Date("2026-10-19T11:00:00.000Z");
		const store = makeStore(
			[
				app({ id: "closed", workflowStartedAt: startedAt }),
				app({ id: "running", workflowStartedAt: startedAt }),
				app({ id: "decided", workflowStartedAt: startedAt }),
				app({ id: "booked", status: "booked", workflowStartedAt: startedAt }),
			],
			["decided"],
		);
		const f = fakes();
		f.describe.mockImplementation(async (workflowId: string) => {
			f.described.push(workflowId);
			if (workflowId.endsWith("closed")) return "CLOSED";
			if (workflowId.endsWith("decided")) return "NOT_FOUND";
			return "RUNNING";
		});

		const counts = await reconcileOnce({
			now: NOW,
			store,
			describe: f.describe,
			startWorkflow: f.startWorkflow,
		});

		expect(counts).toMatchObject({ failed: 1, skipped: 0 });
		expect(store.apps.get("closed")?.status).toBe("failed");
		expect(store.apps.get("closed")?.failedReason).toBe(ENDED_WITHOUT_DECISION);
		expect(store.apps.get("running")?.status).toBe("submitted");
		expect(store.apps.get("decided")?.status).toBe("submitted");
		// Terminal states are never described, let alone overwritten.
		expect(f.described.some((w) => w.endsWith("booked"))).toBe(false);
		expect(store.apps.get("booked")?.status).toBe("booked");
		expect(f.startWorkflow).not.toHaveBeenCalled();
	});

	it("(b)+(c) describe errors skip the tick without writes", async () => {
		const store = makeStore([
			app({ id: "s", workflowStartedAt: OLD }),
			app({ id: "p", status: "processing", submittedAt: OLD, updatedAt: OLD }),
		]);
		const f = fakes();
		f.describe.mockRejectedValue(new Error("temporal down"));

		const counts = await reconcileOnce({
			now: NOW,
			store,
			describe: f.describe,
			startWorkflow: f.startWorkflow,
		});

		expect(counts).toMatchObject({ failed: 0, expired: 0, skipped: 2 });
		expect(store.apps.get("s")?.status).toBe("submitted");
		expect(store.apps.get("p")?.status).toBe("processing");
	});

	it("(c) stale processing fails, stale pending_review expires, fresh untouched", async () => {
		const store = makeStore([
			app({
				id: "proc",
				status: "processing",
				submittedAt: OLD,
				updatedAt: OLD,
			}),
			app({
				id: "rev",
				status: "pending_review",
				submittedAt: OLD,
				updatedAt: OLD,
			}),
			app({
				id: "kept",
				status: "pending_review",
				submittedAt: OLD,
				updatedAt: OLD,
			}),
			app({
				id: "new",
				status: "processing",
				submittedAt: FRESH,
				updatedAt: FRESH,
			}),
		]);
		const f = fakes();
		f.describe.mockImplementation(async (workflowId: string) => {
			if (workflowId.endsWith("kept")) return "RUNNING";
			return "CLOSED";
		});

		const counts = await reconcileOnce({
			now: NOW,
			store,
			describe: f.describe,
			startWorkflow: f.startWorkflow,
		});

		expect(counts).toMatchObject({ failed: 1, expired: 1, skipped: 0 });
		expect(store.apps.get("proc")?.status).toBe("failed");
		expect(store.apps.get("rev")?.status).toBe("expired");
		expect(store.apps.get("kept")?.status).toBe("pending_review");
		expect(store.apps.get("new")?.status).toBe("processing");
		expect(f.startWorkflow).not.toHaveBeenCalled();
	});

	it("(c) stale + decided + not running resumes booking instead of failing", async () => {
		const store = makeStore(
			[
				app({
					id: "stranded",
					status: "processing",
					submittedAt: OLD,
					updatedAt: OLD,
				}),
			],
			["stranded"],
		);
		const f = fakes();
		f.describe.mockResolvedValue("CLOSED");

		const counts = await reconcileOnce({
			now: NOW,
			store,
			describe: f.describe,
			startWorkflow: f.startWorkflow,
		});

		expect(counts).toMatchObject({ repaired: 1, failed: 0, skipped: 0 });
		expect(store.repaired).toEqual(["stranded"]);
		expect(store.apps.get("stranded")?.status).toBe("processing");
	});

	it("(c) a transient repair error skips (retry next tick), never fails the case", async () => {
		const store = makeStore(
			[
				app({
					id: "stuck",
					status: "processing",
					submittedAt: OLD,
					updatedAt: OLD,
				}),
			],
			["stuck"],
			{ repair: "throw" },
		);
		const f = fakes();
		f.describe.mockResolvedValue("NOT_FOUND");

		const counts = await reconcileOnce({
			now: NOW,
			store,
			describe: f.describe,
			startWorkflow: f.startWorkflow,
		});

		expect(counts).toMatchObject({ repaired: 0, failed: 0, skipped: 1 });
		expect(store.apps.get("stuck")?.status).toBe("processing");
		expect(store.apps.get("stuck")?.failedReason).toBeNull();
	});
});
