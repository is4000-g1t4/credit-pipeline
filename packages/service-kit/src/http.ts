// Typed error envelope (SPEC FR-11.3): {error:{code,message,fields?}}.
// Handlers throw HttpError; createService maps it. Nothing here logs or leaks.
import type { Context } from "hono";
import type { ZodError } from "zod";

export class HttpError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
		public fields?: Record<string, string[]>,
	) {
		super(message);
	}
}

export function errorBody(
	code: string,
	message: string,
	fields?: Record<string, string[]>,
): {
	error: { code: string; message: string; fields?: Record<string, string[]> };
} {
	return fields === undefined ? { error: { code, message } } : { error: { code, message, fields } };
}

/** Zod issues → {path: [messages]} for the envelope's `fields`. */
export function zodFields(err: ZodError): Record<string, string[]> {
	const fields: Record<string, string[]> = {};
	for (const issue of err.issues) {
		const key = issue.path.map(String).join(".") || "_";
		const list = fields[key];
		if (list) list.push(issue.message);
		else fields[key] = [issue.message];
	}
	return fields;
}

/** JSON body or a 400 — never a thrown SyntaxError to the 500 handler. */
export async function readJson(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new HttpError(400, "INVALID_JSON", "request body must be JSON");
	}
}
