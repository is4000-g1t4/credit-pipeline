// get_document_findings: document finding metadata (no document text).
import {
	ContextToolError,
	emptyParams,
	type ContextToolSpec,
	type ToolContext,
} from "../tool-context.js";

export const getDocumentFindings = {
	name: "get_document_findings",
	description: "Document finding metadata with expected/observed values (no document text).",
	parameters: emptyParams,
	async run(ctx: ToolContext): Promise<unknown> {
		const body = (await ctx.get(
			`/internal/applications/${ctx.deps.applicationId}/context/document-findings`,
		)) as { findings?: unknown; crosscheck?: unknown; stale?: unknown };
		if (!body || !Array.isArray(body.findings)) {
			throw new ContextToolError("document-findings shape drift");
		}
		for (const f of body.findings as Array<Record<string, unknown>>) {
			if (typeof f["id"] === "string") ctx.seen(f["id"] as string, "finding");
		}
		return {
			crosscheck: body.crosscheck ?? null,
			findings: body.findings,
			stale: body.stale ?? false,
		};
	},
} satisfies ContextToolSpec<void>;
