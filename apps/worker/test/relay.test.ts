// Relay unit tests (compose-free): batching, key selection, stop-on-first-
// failure, the 10-attempt dead-letter cap, and lock contention — all
// against a fake store + fake producer through the relayOnce seam.

import { describe, expect, it, vi } from "vitest";
import {
	MAX_RELAY_ATTEMPTS,
	type OutboxRelayRow,
	type RelayStore,
	relayOnce,
} from "../src/outbox/relay.js";

interface FakeRow extends OutboxRelayRow {
	publishedAt: Date | null;
	deadLetteredAt: Date | null;
	lastError: string | null;
}

function makeStore(
	rows: FakeRow[],
	opts: { locked: boolean } = { locked: true },
): RelayStore & { rows: FakeRow[]; unlocks: number; attempts: string[] } {
	const state = { unlocks: 0, attempts: [] as string[] };
	return {
		rows,
		get unlocks() {
			return state.unlocks;
		},
		get attempts() {
			return state.attempts;
		},
		async tryLock() {
			return opts.locked;
		},
		async unlock() {
			state.unlocks++;
		},
		async fetchBatch(limit) {
			return rows
				.filter((r) => !r.publishedAt && !r.deadLetteredAt)
				.slice(0, limit)
				.map(({ publishedAt: _p, deadLetteredAt: _d, lastError: _l, ...rest }) => rest);
		},
		async markPublished(id, now) {
			const found = rows.find((r) => r.id === id);
			if (found) found.publishedAt = now;
		},
		async markAttempt(id, _now, lastError, deadLetter) {
			const found = rows.find((r) => r.id === id);
			if (!found) return;
			state.attempts.push(id);
			found.attempts++;
			found.lastError = lastError;
			if (deadLetter) found.deadLetteredAt = new Date();
		},
	};
}

function row(overrides: Partial<FakeRow> & { id: string }): FakeRow {
	return {
		topic: "credit.ews.alert",
		key: null,
		payload: { id: "evt-1", type: "ews.alert" },
		attempts: 0,
		publishedAt: null,
		deadLetteredAt: null,
		lastError: null,
		...overrides,
	};
}

function makeProducer(failAt?: number, message = "kafka down") {
	const sent: Array<{ topic: string; key?: string; value: string }> = [];
	let calls = 0;
	return {
		sent,
		send: vi.fn(
			async (args: { topic: string; messages: Array<{ key?: string; value: string }> }) => {
				const at = calls++;
				if (failAt === at) throw new Error(message);
				sent.push({ topic: args.topic, ...args.messages[0] });
			},
		),
	};
}

const NOW = new Date("2026-10-19T12:00:00.000Z");

describe("relayOnce", () => {
	it("publishes in order with key applicationId ?? loanId and marks published", async () => {
		const store = makeStore([
			row({
				id: "a",
				payload: { id: "e1", applicationId: "app-1", loanId: "loan-1" },
			}),
			row({ id: "b", payload: { id: "e2", loanId: "loan-2" } }),
			row({ id: "c", key: "fallback", payload: { id: "e3" } }),
		]);
		const producer = makeProducer();
		const result = await relayOnce({ now: NOW, producer, store });

		expect(result).toEqual({ skipped: false, published: 3, deadLettered: 0 });
		expect(producer.sent.map((s) => s.key)).toEqual(["app-1", "loan-2", "fallback"]);
		// Payload is the stored envelope, untouched.
		expect(producer.sent[0]?.value).toBe(
			JSON.stringify({ id: "e1", applicationId: "app-1", loanId: "loan-1" }),
		);
		expect(store.rows.every((r) => r.publishedAt?.getTime() === NOW.getTime())).toBe(true);
		expect(store.unlocks).toBe(1);
	});

	it("stops the batch on first failure and records the attempt", async () => {
		const store = makeStore([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]);
		const producer = makeProducer(1, "record too large"); // second send throws (message-level)
		const result = await relayOnce({ now: NOW, producer, store });

		expect(result).toEqual({ skipped: false, published: 1, deadLettered: 0 });
		expect(producer.send).toHaveBeenCalledTimes(2);
		expect(store.rows[0]?.publishedAt).not.toBeNull();
		expect(store.rows[1]?.attempts).toBe(1);
		expect(store.rows[1]?.lastError).toBe("record too large");
		// Third row never attempted — order preserved, lock still released.
		expect(store.rows[2]?.attempts).toBe(0);
		expect(store.unlocks).toBe(1);
	});

	it("burns nothing on connection-level outages and resets the producer", async () => {
		const store = makeStore([row({ id: "a" }), row({ id: "b" })]);
		const outage = Object.assign(new Error("Broker not available"), {
			name: "KafkaJSNoBrokerAvailableError",
		});
		let calls = 0;
		const producer = {
			send: vi.fn(async () => {
				if (calls++ === 1) throw outage;
			}),
		};
		const onConnectionError = vi.fn();
		const result = await relayOnce({ now: NOW, producer, store, onConnectionError });

		expect(result).toEqual({ skipped: false, published: 1, deadLettered: 0 });
		expect(onConnectionError).toHaveBeenCalledOnce();
		expect(store.rows[0]?.publishedAt).not.toBeNull();
		expect(store.rows[1]?.attempts).toBe(0);
		expect(store.rows[1]?.lastError).toBeNull();
		expect(store.unlocks).toBe(1);
	});

	it("a first-row connection failure publishes nothing and burns nothing", async () => {
		const store = makeStore([row({ id: "a" }), row({ id: "b" })]);
		const outage = Object.assign(new Error("connection reset by peer"), {
			name: "KafkaJSConnectionError",
		});
		const producer = {
			send: vi.fn(async () => {
				throw outage;
			}),
		};
		const onConnectionError = vi.fn();
		const result = await relayOnce({ now: NOW, producer, store, onConnectionError });

		expect(result).toEqual({ skipped: false, published: 0, deadLettered: 0 });
		expect(onConnectionError).toHaveBeenCalledOnce();
		for (const r of store.rows) {
			expect(r.publishedAt).toBeNull();
			expect(r.attempts).toBe(0);
			expect(r.lastError).toBeNull();
		}
		expect(store.unlocks).toBe(1);
	});

	it("a KafkaJS connection error (or outage in `cause`) burns nothing", async () => {
		const store = makeStore([row({ id: "a" })]);
		const outage = Object.assign(new Error("connection reset"), {
			name: "KafkaJSConnectionError",
		});
		const wrapped = new Error("send failed");
		(wrapped as { cause?: unknown }).cause = Object.assign(new Error("Broker not available"), {
			name: "KafkaJSNoBrokerAvailableError",
		});
		for (const err of [outage, wrapped]) {
			const producer = {
				send: vi.fn(async () => {
					throw err;
				}),
			};
			const onConnectionError = vi.fn();
			const result = await relayOnce({ now: NOW, producer, store, onConnectionError });
			expect(result).toEqual({ skipped: false, published: 0, deadLettered: 0 });
			expect(onConnectionError).toHaveBeenCalledOnce();
			expect(store.rows[0]?.attempts).toBe(0);
			expect(store.rows[0]?.lastError).toBeNull();
		}
	});

	it("a retriable protocol error is message-level and burns an attempt", async () => {
		const store = makeStore([row({ id: "a" })]);
		const producer = {
			send: vi.fn(async () => {
				throw Object.assign(new Error("CORRUPT_MESSAGE"), {
					name: "KafkaJSProtocolError",
					retriable: true,
				});
			}),
		};
		const onConnectionError = vi.fn();
		const result = await relayOnce({ now: NOW, producer, store, onConnectionError });
		expect(result).toEqual({ skipped: false, published: 0, deadLettered: 0 });
		expect(onConnectionError).not.toHaveBeenCalled();
		expect(store.rows[0]?.attempts).toBe(1);
		expect(store.rows[0]?.lastError).toContain("CORRUPT_MESSAGE");
	});

	it("a markPublished failure after a send keeps the producer and republishes later", async () => {
		const store = makeStore([row({ id: "a" }), row({ id: "b" })]);
		const producer = makeProducer();
		const onConnectionError = vi.fn();
		let calls = 0;
		const inner = store.markPublished.bind(store);
		store.markPublished = async (id: string, now: Date) => {
			if (calls++ === 0) throw new Error("db connection lost");
			return inner(id, now);
		};
		const result = await relayOnce({ now: NOW, producer, store, onConnectionError });

		// The send landed but the row stays unpublished (at-least-once: it
		// may republish); the producer is NOT reset and the batch stops.
		expect(result).toEqual({ skipped: false, published: 0, deadLettered: 0 });
		expect(onConnectionError).not.toHaveBeenCalled();
		expect(producer.send).toHaveBeenCalledTimes(1);
		expect(store.rows[0]?.publishedAt).toBeNull();
		expect(store.rows[0]?.attempts).toBe(0);
		expect(store.rows[1]?.attempts).toBe(0);
		expect(store.unlocks).toBe(1);
	});

	it(`dead-letters on the ${MAX_RELAY_ATTEMPTS}th failure and skips it after`, async () => {
		const store = makeStore([row({ id: "poison", attempts: MAX_RELAY_ATTEMPTS - 1 })]);
		const producer = makeProducer(0);
		const result = await relayOnce({ now: NOW, producer, store });

		expect(result).toEqual({ skipped: false, published: 0, deadLettered: 1 });
		expect(store.rows[0]?.attempts).toBe(MAX_RELAY_ATTEMPTS);
		expect(store.rows[0]?.deadLetteredAt).not.toBeNull();

		const again = await relayOnce({
			now: NOW,
			producer: makeProducer(),
			store,
		});
		expect(again).toEqual({ skipped: false, published: 0, deadLettered: 0 });
	});

	it("returns skipped when the advisory lock is held elsewhere", async () => {
		const store = makeStore([row({ id: "a" })], { locked: false });
		const producer = makeProducer();
		const result = await relayOnce({ now: NOW, producer, store });

		expect(result).toEqual({ skipped: true, published: 0, deadLettered: 0 });
		expect(producer.send).not.toHaveBeenCalled();
	});
});
