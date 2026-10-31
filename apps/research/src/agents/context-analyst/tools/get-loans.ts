// get_loans: existing loans, installments, and open EWS alerts. Always
// resolves the applicant id fresh through /context/applicant first (2 HTTP
// units per call), then reads the loans service's service-only lookup.
import {
	ContextToolError,
	emptyParams,
	type ContextToolSpec,
	type ToolContext,
} from "../tool-context.js";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const getLoans = {
	name: "get_loans",
	description: "Existing loans, installment/overdue counts, and open EWS alerts for the applicant.",
	parameters: emptyParams,
	async run(ctx: ToolContext): Promise<unknown> {
		const { deps } = ctx;
		// Fresh consent-gated applicant lookup immediately before the
		// loans fetch: the /context/applicant read narrows the race
		// window for a withdrawal racing the stage (it does not close
		// it — the loans service revalidates consent and the
		// application binding itself before any loan row is read).
		// Never served from cache here.
		const fresh = (await ctx.get(
			`/internal/applications/${deps.applicationId}/context/applicant`,
		)) as { applicantUserId?: unknown };
		const userId = typeof fresh?.applicantUserId === "string" ? fresh.applicantUserId : null;
		if (!userId) {
			// Fail closed but usable: the model sees an explicit data gap
			// rather than a silent empty exposure picture.
			return { loans: [], unavailable: "applicant id unavailable" };
		}
		const rawAsOf =
			typeof deps.asOfDate === "string" && deps.asOfDate !== ""
				? deps.asOfDate
				: typeof deps.caseFacts["asOf"] === "string"
					? (deps.caseFacts["asOf"] as string).slice(0, 10)
					: "";
		if (!DAY_RE.test(rawAsOf)) throw new ContextToolError("invalid asOf");
		const q = new URLSearchParams({ applicationId: deps.applicationId, asOf: rawAsOf });
		const body = (await ctx.getFrom(
			deps.env.loansUrl,
			`/internal/loans/by-applicant/${userId}?${q}`,
		)) as { loans?: unknown };
		if (!body || !Array.isArray(body.loans)) {
			throw new ContextToolError("loans shape drift");
		}
		return { loans: body.loans };
	},
} satisfies ContextToolSpec<void>;
