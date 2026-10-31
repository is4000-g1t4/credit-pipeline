import { hashQuote } from "@credit/core";
import { createDrawerToken } from "./agents/policy-answerer/index.js";
import type { Actor } from "./retrieval.js";

/** Service identity for the policy-exception bridge (resolve + search). */
export const SERVICE_CASE_EXPLAIN: Actor = {
	id: "service:case_explain",
	role: "service",
	policyRoles: [],
};

const SECTION_BODY_CAP = 8000;
const TOTAL_BODY_CAP = 40000;

export interface BridgeRow {
	policyId: string;
	policyVersionId: string;
	policyKey: string;
	sectionId: string;
	version: string;
	heading: string;
	body: string;
	effectiveFrom: string;
	effectiveTo: string | null;
	contentHash: string;
}

export function capBridgeBodies(
	rows: BridgeRow[],
): Array<{ row: BridgeRow; body: string; truncated: boolean }> {
	let total = 0;
	return rows.map((row) => {
		let body = row.body;
		let truncated = false;
		if (body.length > SECTION_BODY_CAP) {
			body = body.slice(0, SECTION_BODY_CAP);
			truncated = true;
		}
		if (total + body.length > TOTAL_BODY_CAP) {
			const room = TOTAL_BODY_CAP - total;
			if (room <= 0) {
				body = "";
				truncated = true;
			} else {
				body = body.slice(0, room);
				truncated = true;
			}
		}
		total += body.length;
		return { row, body, truncated };
	});
}

export function toBridgeDelivery(
	capped: { row: BridgeRow; body: string; truncated: boolean },
	secret: string,
	asOf: string,
	queryId: string,
): {
	policyId: string;
	policyVersionId: string;
	policyKey: string;
	sectionId: string;
	version: string;
	heading: string;
	body: string;
	truncated: boolean;
	effectiveFrom: string;
	effectiveTo: string | null;
	contentHash: string;
	quoteHash: string;
	drawerToken: string;
} {
	const { row, body, truncated } = capped;
	return {
		policyId: row.policyId,
		policyVersionId: row.policyVersionId,
		policyKey: row.policyKey,
		sectionId: row.sectionId,
		version: row.version,
		heading: row.heading,
		body,
		truncated,
		effectiveFrom: row.effectiveFrom,
		effectiveTo: row.effectiveTo,
		contentHash: row.contentHash,
		quoteHash: hashQuote(body),
		drawerToken: createDrawerToken(secret, {
			versionId: row.policyVersionId,
			sectionId: row.sectionId,
			asOf,
			queryId,
		}),
	};
}
