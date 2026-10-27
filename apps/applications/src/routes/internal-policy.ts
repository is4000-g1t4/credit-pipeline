// EN-07 case rule-failure contract for the policy service's case-rule
// tool: deterministic engine failures + exception paths, metadata-only
// audit. Second HMAC binds method/path/case/actor/ts/requestId under
// POLICY_RULE_CONTEXT_SECRET (5-minute skew); the first (service) HMAC
// is already enforced globally by requireInternal in createService.
import { withTx, type Db } from "@credit/db/applications";
import {
	HttpError,
	requireService,
	writeAudit,
	type ServiceApp,
} from "@credit/service-kit";
import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isUuid } from "../ids.js";
import {
	buildCaseRuleContext,
	RuleContextUnavailableError,
	UnsupportedPolicyVersionError,
} from "../assist/policy-rules.js";

export interface InternalPolicyRouteDeps {
	db: Db;
	/** EN-07 case rule-failure contract: flag + second HMAC secret. */
	policyRuleContext?: { enabled: boolean; secret: string | null };
}

export function internalPolicyRoutes(deps: InternalPolicyRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { db } = deps;
	// EN-07 case rule-failure contract for the policy service's case-rule
	// tool: deterministic engine failures + exception paths, metadata-only
	// audit. Second HMAC binds method/path/case/actor/ts/requestId under
	// POLICY_RULE_CONTEXT_SECRET (5-minute skew); the first (service) HMAC
	// is already enforced globally by requireInternal in createService.
	const RULE_CONTEXT_SKEW_MS = 5 * 60 * 1000;

	function verifyRuleContextSignature(input: {
		secret: string;
		method: string;
		path: string;
		applicationId: string;
		actor: string;
		ts: string | undefined;
		signature: string | undefined;
		requestId: string | undefined;
	}): void {
		const { secret, method, path, applicationId, actor, ts, signature, requestId } = input;
		if (!ts || !signature || !requestId) {
			throw new HttpError(403, "RULE_CONTEXT_FORBIDDEN", "rule context signature required");
		}
		const at = Number(ts);
		if (!Number.isFinite(at) || Math.abs(Date.now() - at) > RULE_CONTEXT_SKEW_MS) {
			throw new HttpError(403, "RULE_CONTEXT_FORBIDDEN", "rule context signature expired");
		}
		const message = `${method}\n${path}\n${applicationId}\n${actor}\n${ts}\n${requestId}`;
		const expected = createHmac("sha256", secret).update(message, "utf8").digest("hex");
		const a = Buffer.from(signature, "utf8");
		const b = Buffer.from(expected, "utf8");
		if (a.length !== b.length || !timingSafeEqual(a, b)) {
			throw new HttpError(403, "RULE_CONTEXT_FORBIDDEN", "invalid rule context signature");
		}
	}

	app.get("/internal/applications/:id/rule-failures", requireService, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		if (!deps.policyRuleContext?.enabled) throw new HttpError(404, "NOT_FOUND", "not found");
		const secret = deps.policyRuleContext.secret;
		if (!secret) {
			throw new HttpError(
				503,
				"RULE_CONTEXT_AUTH_UNAVAILABLE",
				"rule context auth is not configured",
			);
		}
		verifyRuleContextSignature({
			secret,
			method: c.req.method,
			path: c.req.path,
			applicationId: id,
			actor: me.id,
			ts: c.req.header("x-rule-context-ts"),
			signature: c.req.header("x-rule-context-signature"),
			requestId: c.req.header("x-request-id"),
		});
		let context;
		try {
			context = await buildCaseRuleContext({ db, applicationId: id });
		} catch (err) {
			if (err instanceof RuleContextUnavailableError) {
				throw new HttpError(409, "RULE_CONTEXT_UNAVAILABLE", err.message);
			}
			if (err instanceof UnsupportedPolicyVersionError) {
				throw new HttpError(409, "UNSUPPORTED_POLICY_VERSION", err.message);
			}
			throw err;
		}
		await withTx(db, (tx) =>
			writeAudit(tx, {
				applicationId: id,
				actor: me.id,
				action: "policy.rule_failures_read",
				entity: "policy_evaluation",
				payload: {
					feature: "policy_exception",
					applicationId: id,
					policyVersion: context.policyVersion,
					registryVersion: context.registryVersion,
					outcome: context.outcome,
					scoreBand: context.grade,
					ruleIds: context.failedRules.map((rule) => rule.ruleId),
					reasonCodes: context.reasonCodes,
					mappingStates: context.failedRules.map((rule) => rule.mappingState),
					persistedCount: context.failedRules.filter((rule) => rule.persisted).length,
				},
			}),
		);
		return c.json({ context });
	});

	return app;
}
