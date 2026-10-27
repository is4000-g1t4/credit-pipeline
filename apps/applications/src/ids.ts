// Shared request-identity helpers: one UUID check and one idempotency
// replay read for the draft/submit/direct-create routes (identical 409s).
import { idempotencyKeys, type Db } from "@credit/db/applications";
import { HttpError } from "@credit/service-kit";
import { and, eq } from "drizzle-orm";

export { UUID_RE, isUuid } from "@credit/service-kit";

/** Fast-path replay read (no lock): null when unused, 409 on hash/app
 * mismatch. Submit passes `applicationId`; create/draft-create omit it. */
export async function readIdempotencyReplay(
	db: Db,
	input: { userId: string; key: string; requestHash: string; applicationId?: string },
): Promise<{ id: string; reference: string } | null> {
	const rows = await db
		.select()
		.from(idempotencyKeys)
		.where(and(eq(idempotencyKeys.userId, input.userId), eq(idempotencyKeys.key, input.key)));
	const row = rows[0];
	if (!row) return null;
	if (row.requestHash !== input.requestHash) {
		throw new HttpError(
			409,
			"IDEMPOTENCY_CONFLICT",
			"Idempotency-Key was already used with a different payload",
		);
	}
	if (input.applicationId !== undefined && row.applicationId !== input.applicationId) {
		throw new HttpError(
			409,
			"IDEMPOTENCY_CONFLICT",
			"Idempotency-Key belongs to a different application",
		);
	}
	return row.response as { id: string; reference: string };
}
