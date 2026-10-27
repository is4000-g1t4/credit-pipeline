// Shared API client (SPEC §6): same-origin /api proxy, cookie session,
// JSON-only, typed errors. All queries run client-side (SSR renders shells).
import type { DocumentFile, DocumentKind } from "./documents";

export class ApiError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
		public fields?: Record<string, string[]>,
	) {
		super(message);
	}
}

/** Build the typed error for a non-2xx JSON body; unknown shapes fall
 * back to REQUEST_FAILED with the status in the message. */
export function parseApiError(res: Response, data?: unknown): ApiError {
	const err = (
		data as {
			error?: {
				code?: string;
				message?: string;
				fields?: Record<string, string[]>;
			};
		} | null
	)?.error;
	return new ApiError(
		res.status,
		err?.code ?? "REQUEST_FAILED",
		err?.message ?? `request failed (${res.status})`,
		err?.fields,
	);
}

/** 404 → null ("not present yet"); every other error throws. */
export async function nullOn404<T>(fn: () => Promise<T>): Promise<T | null> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof ApiError && err.status === 404) return null;
		throw err;
	}
}

export async function api<T>(
	path: string,
	opts?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<T> {
	const res = await fetch(path, {
		method: opts?.method ?? "GET",
		credentials: "include",
		headers: {
			...(opts?.body !== undefined ? { "content-type": "application/json" } : {}),
			...opts?.headers,
		},
		body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
	});
	if (res.status === 204) return undefined as T;
	const data = await readJson(res);
	if (!res.ok) {
		throw parseApiError(res, data);
	}
	return data as T;
}

/** Shared JSON parse path: BAD_RESPONSE when the body is not JSON. */
async function readJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		throw new ApiError(res.status, "BAD_RESPONSE", `request failed (${res.status})`);
	}
}

/** Multipart upload — fetch sets the boundary; never set content-type here. */
export async function uploadDocument(
	applicationId: string,
	file: File,
	kind: DocumentKind,
): Promise<{ file: DocumentFile }> {
	const form = new FormData();
	form.append("file", file);
	form.append("kind", kind);
	const res = await fetch(`/api/applications/${applicationId}/documents`, {
		method: "POST",
		credentials: "include",
		body: form,
	});
	const data = await readJson(res);
	if (!res.ok) {
		throw parseApiError(res, data);
	}
	return data as { file: DocumentFile };
}

/** Authenticated download via blob + object URL; the caller opens/saves and
 * revokes. Returns the blob and a safe filename (id-based, never logged). */
export async function downloadDocument(
	applicationId: string,
	fileId: string,
): Promise<{ blob: Blob; filename: string }> {
	const res = await fetch(`/api/applications/${applicationId}/documents/${fileId}/file`, {
		credentials: "include",
	});
	if (!res.ok) {
		let data: unknown;
		try {
			data = await res.json();
		} catch {
			// Binary error body — parseApiError falls back to the status message.
			data = undefined;
		}
		throw parseApiError(res, data);
	}
	const blob = await res.blob();
	const disposition = res.headers.get("content-disposition") ?? "";
	const match = /filename="([^"]+)"/.exec(disposition);
	return { blob, filename: match?.[1] ?? `${fileId}.bin` };
}

/** Minimal toast bus — the Toaster in __root listens for these. */
export function toast(message: string): void {
	window.dispatchEvent(new CustomEvent<string>("app-toast", { detail: message }));
}

export function apiErrorMessage(err: unknown): string {
	return err instanceof ApiError ? err.message : "something went wrong";
}

/** Same as apiErrorMessage but prefixed with the machine code when typed. */
export function apiErrorWithCode(err: unknown): string {
	return err instanceof ApiError ? `${err.code}: ${apiErrorMessage(err)}` : apiErrorMessage(err);
}
