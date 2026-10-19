// Health-check primitives for service `/health` endpoints: a DB ping and a
// Temporal connectivity probe, each with a 1s timeout. The DB ping is
// injected so this package needs no driver dependency.
import { Connection } from "@temporalio/client";

const CHECK_TIMEOUT_MS = 1000;

export interface HealthCheck {
	ok: boolean;
	error?: string;
}

export type HealthChecks = Record<string, HealthCheck>;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error("timeout")), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function checkDb(ping: () => Promise<unknown>): Promise<HealthCheck> {
	try {
		await withTimeout(ping(), CHECK_TIMEOUT_MS);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export async function checkTemporal(address: string): Promise<HealthCheck> {
	let settled = false;
	const pending = Connection.connect({ address });
	void pending.then(
		(conn) => {
			if (settled) void conn.close().catch(() => {});
		},
		() => {},
	);
	try {
		const connection = await withTimeout(pending, CHECK_TIMEOUT_MS);
		settled = true;
		await connection.close().catch(() => {});
		return { ok: true };
	} catch (err) {
		settled = true;
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Outbox backlog for the writer services' `/health` (SPEC FR-10.3/AC-17):
 * unpublished-non-dead rows plus dead-lettered rows. Extra numeric fields
 * serialize into the checks map so the gateway can aggregate them. */
export async function checkOutbox(
	run: () => Promise<Array<{ backlog: number; dead: number }>>,
): Promise<HealthCheck & { backlog: number | null; deadLettered: number | null }> {
	try {
		const rows = await withTimeout(run(), CHECK_TIMEOUT_MS);
		return {
			ok: true,
			backlog: rows[0]?.backlog ?? null,
			deadLettered: rows[0]?.dead ?? null,
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			backlog: null,
			deadLettered: null,
		};
	}
}
