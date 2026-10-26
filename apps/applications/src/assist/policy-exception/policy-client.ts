// Signed applications -> policy client for the E3 policy bridge.
//
// The policy service returns policy text only (never case data). Transport,
// 5xx, and auth failures are typed `POLICY_SOURCE_UNAVAILABLE`, never a
// generic 500. The caller's abort signal is combined with the per-call
// timeout so an aborted agent also aborts the policy fetch.

import { randomUUID } from "node:crypto";
import { signInternalHeaders } from "@credit/service-kit";
import { z } from "zod";
import {
	PolicySourceError,
	type PolicyClient,
	type PolicySectionDelivery,
	type PolicySourceResponse,
} from "./types.js";

const sectionSchema = z
	.object({
		policyId: z.uuid(),
		policyVersionId: z.uuid(),
		policyKey: z.string().min(1).max(80),
		sectionId: z.string().min(1).max(64),
		version: z.string().min(1).max(20),
		heading: z.string().min(1).max(200),
		body: z.string().min(1),
		truncated: z.boolean(),
		effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
		effectiveTo: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/)
			.nullable(),
		contentHash: z.string().min(16).max(128),
		quoteHash: z.string().min(16).max(128),
		drawerToken: z.string().min(1).max(4_000),
	})
	.strict();

const responseSchema = z
	.object({
		status: z.enum(["ok", "partial", "out_of_scope", "identifier_blocked"]),
		sections: z.array(sectionSchema).max(50),
		missing: z
			.array(
				z
					.object({
						policyKey: z.string().min(1).max(80),
						sectionId: z.string().min(1).max(64),
						reason: z.enum(["not_found", "not_effective", "forbidden", "truncated"]),
					})
					.strict(),
			)
			.max(50),
	})
	.strict();

const SERVICE_ID = "00000000-0000-0000-0000-000000000000";

export interface HttpPolicyClientOptions {
	baseUrl: string;
	secret: string;
	timeoutMs: number;
	fetchImpl?: typeof fetch;
}

export function createHttpPolicyClient(opts: HttpPolicyClientOptions): PolicyClient {
	if (!opts.secret) throw new Error("policy client requires POLICY_INTERNAL_SECRET");
	const post = async (
		path: string,
		body: unknown,
		signal: AbortSignal | undefined,
	): Promise<PolicySourceResponse> => {
		const bytes = JSON.stringify(body);
		const headers: Record<string, string> = {
			"content-type": "application/json",
			...signInternalHeaders(opts.secret, {
				userId: SERVICE_ID,
				email: "service:applications",
				role: "service",
				method: "POST",
				path,
				body: bytes,
				requestId: randomUUID(),
			}),
		};
		const timeout = AbortSignal.timeout(opts.timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let response: Response;
		try {
			response = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl.replace(/\/$/, "")}${path}`, {
				method: "POST",
				headers,
				body: bytes,
				signal: combined,
			});
		} catch {
			throw new PolicySourceError("POLICY_SOURCE_UNAVAILABLE");
		}
		if (response.status === 429) {
			throw new PolicySourceError("POLICY_SOURCE_BUDGET", 429);
		}
		if (!response.ok) {
			throw new PolicySourceError(
				response.status >= 500 || response.status === 401 || response.status === 403
					? "POLICY_SOURCE_UNAVAILABLE"
					: "POLICY_SOURCE_INVALID",
				response.status,
			);
		}
		let json: unknown;
		try {
			json = await response.json();
		} catch {
			throw new PolicySourceError("POLICY_SOURCE_INVALID", response.status);
		}
		const parsed = responseSchema.safeParse(json);
		if (!parsed.success) {
			throw new PolicySourceError("POLICY_SOURCE_INVALID", response.status);
		}
		if (parsed.data.status === "out_of_scope" || parsed.data.status === "identifier_blocked") {
			return { status: "ok", sections: [], missing: [] };
		}
		return {
			status: parsed.data.status === "partial" ? "partial" : "ok",
			sections: parsed.data.sections,
			missing: parsed.data.missing,
		};
	};

	return {
		resolveSections(input, options) {
			return post(
				"/internal/policy/sections/resolve",
				{
					applicationId: input.applicationId,
					actorId: input.actorId,
					actorRole: input.actorRole,
					policyAsOf: input.policyAsOf,
					productScope: input.productScope,
					refs: input.refs,
				},
				options?.signal,
			);
		},
		searchSections(input, options) {
			return post(
				"/internal/policy/search",
				{
					applicationId: input.applicationId,
					actorId: input.actorId,
					actorRole: input.actorRole,
					policyAsOf: input.policyAsOf,
					productScope: input.productScope,
					query: input.query,
					topK: input.topK ?? 8,
				},
				options?.signal,
			);
		},
	};
}

export function sectionsByRef(
	sections: readonly PolicySectionDelivery[],
): Map<string, PolicySectionDelivery> {
	return new Map(sections.map((section) => [`${section.policyKey}#${section.sectionId}`, section]));
}
