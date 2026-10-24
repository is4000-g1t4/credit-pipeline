// Service-side outbox + audit writers (FR-10.2/10.3/10.5: strict event
// envelopes, dedupe keys, PII-key guard) — shared here so production
// service code and the worker activities import one copy.
import { buildEnvelope, type EventType, eventEnvelopeSchema, TOPICS } from "@credit/core";
import { auditLog, outboxEvents, type Tx } from "@credit/db/shared";

export interface OutboxInput {
	type: EventType;
	key: string;
	payload: unknown;
	dedupeKey: string;
	applicationId?: string;
	loanId?: string;
}

/** Envelope-validate (strict schemas reject PII — AC-18), then insert with
 * ON CONFLICT (dedupe_key) DO NOTHING inside the caller's transaction. */
export async function insertOutbox(tx: Tx, input: OutboxInput): Promise<void> {
	const envelope = buildEnvelope({
		type: input.type,
		payload: input.payload,
		occurredAt: new Date().toISOString(),
		...(input.applicationId !== undefined ? { applicationId: input.applicationId } : {}),
		...(input.loanId !== undefined ? { loanId: input.loanId } : {}),
	});
	eventEnvelopeSchema.parse(envelope);
	await tx
		.insert(outboxEvents)
		.values({
			topic: TOPICS[input.type],
			key: input.key,
			payload: envelope,
			dedupeKey: input.dedupeKey,
		})
		.onConflictDoNothing({ target: outboxEvents.dedupeKey });
}

export interface AuditInput {
	applicationId?: string;
	loanId?: string;
	actor: string;
	action: string;
	entity: string;
	payload: Record<string, unknown>;
}

const FORBIDDEN_KEYS = new Set([
	"nationalid",
	"national_id",
	"dob",
	"dateofbirth",
	"address",
	"phone",
	"email",
	"income",
	"revenue",
	"registrationnumber",
	"registration_number",
]);

function assertAllowlisted(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) assertAllowlisted(item);
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const [key, nested] of Object.entries(value)) {
			if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
				throw new Error(`audit payload must not contain PII key: ${key}`);
			}
			assertAllowlisted(nested);
		}
	}
}

export async function writeAudit(tx: Tx, input: AuditInput): Promise<void> {
	assertAllowlisted(input.payload);
	await tx.insert(auditLog).values({
		applicationId: input.applicationId ?? null,
		loanId: input.loanId ?? null,
		actor: input.actor,
		action: input.action,
		entity: input.entity,
		payload: input.payload,
	});
}
