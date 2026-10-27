// Shared defensive parser for memo-shaped artifact content. Old or
// unexpected rows render as "no content", never crash. The section renderer
// and approval confirm blocks stay per-panel: their citation markup and
// gating copy differ, so sharing would change behavior.

export function asMemoContent<T extends { title: unknown; sections: unknown }>(
	content: unknown,
): T | null {
	if (typeof content !== "object" || content === null) return null;
	const c = content as Record<string, unknown>;
	if (typeof c.title !== "string" || !Array.isArray(c.sections)) return null;
	return content as T;
}
