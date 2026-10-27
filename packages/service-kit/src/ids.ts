// One UUID shape for service boundaries. The canonical form is the same one
// Postgres `uuid` accepts; callers should not re-declare the regex.
export const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_RE.test(value);
}
