// get_transactions: one bounded page for one owned account. Free-text
// descriptions and counterparties are stripped (injection/PII surface); the
// model sees amounts, dates, and categories only.
import { z } from "zod";
import { isUuid } from "../../../ids.js";
import { ContextToolError, type ContextToolSpec, type ToolContext } from "../tool-context.js";

// Strict OpenAI-compatible providers require every property in `required`;
// an optional cursor made the whole tool schema invalid for GPT models.
// The model passes "" for the first page.
const transactionsParams = z
	.object({ accountId: z.string().min(1).max(100), cursor: z.string().max(2000) })
	.strict();

/** Model-visible transaction rows per page: the endpoint pages 500, but the
 * model reasons over a capped head + counts (cost control). */
export const MODEL_TX_ROW_CAP = 50;

export const getTransactions = {
	name: "get_transactions",
	description:
		'Bounded transaction page for one owned account. Pass cursor="" for the first page; use nextCursor from the result to page.',
	parameters: transactionsParams,
	async run(ctx: ToolContext, input: { accountId: string; cursor?: string }): Promise<unknown> {
		if (!isUuid(input.accountId)) throw new ContextToolError("invalid accountId");
		if (
			input.cursor !== undefined &&
			(typeof input.cursor !== "string" || input.cursor.length > 2000)
		) {
			throw new ContextToolError("invalid cursor");
		}
		const q = new URLSearchParams({ accountId: input.accountId });
		if (input.cursor) q.set("cursor", input.cursor);
		const body = (await ctx.get(
			`/internal/applications/${ctx.deps.applicationId}/context/transactions?${q}`,
		)) as {
			items?: Array<Record<string, unknown>>;
			nextCursor?: unknown;
			window?: unknown;
		};
		if (!body || !Array.isArray(body.items)) {
			throw new ContextToolError("transactions shape drift");
		}
		// Strip free-text PII/injection surface: the model needs
		// amounts/dates/categories, never descriptions/counterparties.
		const items = body.items.map((tx) => {
			if (typeof tx["id"] === "string") ctx.seen(tx["id"] as string, "transaction");
			if (typeof tx["accountId"] === "string") ctx.seen(tx["accountId"] as string, "account");
			return {
				id: tx["id"] ?? null,
				accountId: tx["accountId"] ?? null,
				postedAt: tx["postedAt"] ?? null,
				amountCents: tx["amountCents"] ?? null,
				balanceAfterCents: tx["balanceAfterCents"] ?? null,
				currency: tx["currency"] ?? null,
				category: tx["category"] ?? null,
				returned: tx["returned"] ?? null,
			};
		});
		return { window: body.window ?? null, items, nextCursor: body.nextCursor ?? null };
	},
	/** The model reasons over a capped head plus counts. */
	view(result: unknown): unknown {
		const page = result as { window: unknown; items: unknown[]; nextCursor: unknown };
		return {
			window: page.window,
			totalRows: page.items.length,
			items: page.items.slice(0, MODEL_TX_ROW_CAP),
			truncated: page.items.length > MODEL_TX_ROW_CAP,
			nextCursor: page.nextCursor,
		};
	},
} satisfies ContextToolSpec<{ accountId: string; cursor?: string }>;
