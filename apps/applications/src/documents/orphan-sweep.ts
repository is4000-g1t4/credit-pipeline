// D1b orphan sweep: `.enc` files with no DB row older than
// deadline+10min, plus temp files older than 1h. Row rechecked under the
// per-application lock before unlinking.
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { documentFiles, withTx, type Db } from "@credit/db/applications";
import { and, eq, sql } from "drizzle-orm";

export interface SweepResult {
	checked: number;
	removedBlobs: number;
	removedTemps: number;
}

export async function sweepDocumentOrphans(
	db: Db,
	root: string,
	opts: { deadlineMs: number; now?: number },
): Promise<SweepResult> {
	const now = opts.now ?? Date.now();
	const blobMinAge = opts.deadlineMs + 10 * 60_000;
	const tmpMinAge = 60 * 60_000;
	const result: SweepResult = { checked: 0, removedBlobs: 0, removedTemps: 0 };
	let entries: Array<{ name: string; mtime: number; isDir: boolean }>;
	try {
		const names = await fs.readdir(root);
		entries = [];
		for (const name of names) {
			const st = await fs.stat(path.join(root, name)).catch(() => null);
			if (!st) continue;
			entries.push({ name, mtime: st.mtimeMs, isDir: st.isDirectory() });
		}
	} catch {
		return result;
	}
	for (const entry of entries) {
		if (entry.isDir) {
			// `<applicationId>/` shard: scan one level deep.
			const shard = path.join(root, entry.name);
			let inner: string[];
			try {
				inner = await fs.readdir(shard);
			} catch {
				continue;
			}
			for (const name of inner) {
				result.checked++;
				const full = path.join(shard, name);
				const st = await fs.stat(full).catch(() => null);
				if (!st || st.isDirectory()) continue;
				if (name.includes(".tmp-")) {
					if (now - st.mtimeMs > tmpMinAge) {
						await fs.unlink(full).catch(() => {});
						result.removedTemps++;
					}
					continue;
				}
				if (!name.endsWith(".enc")) continue;
				if (now - st.mtimeMs <= blobMinAge) continue;
				const fileId = name.slice(0, -".enc".length);
				const rows = await db
					.select({ id: documentFiles.id })
					.from(documentFiles)
					.where(and(eq(documentFiles.applicationId, entry.name), eq(documentFiles.id, fileId)))
					.limit(1)
					.catch(() => []);
				if (rows.length === 0) {
					// Recheck under the application lock before unlinking.
					const stillOrphan = await withTx(db, async (tx) => {
						await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${entry.name}))`);
						const again = await tx
							.select({ id: documentFiles.id })
							.from(documentFiles)
							.where(and(eq(documentFiles.applicationId, entry.name), eq(documentFiles.id, fileId)))
							.limit(1);
						if (again.length > 0) return false;
						await fs.unlink(full).catch(() => {});
						return true;
					}).catch(() => false);
					if (stillOrphan) result.removedBlobs++;
				}
			}
			continue;
		}
		// Legacy flat temp files at the root.
		if (entry.name.includes(".tmp-") && now - entry.mtime > tmpMinAge) {
			await fs.unlink(path.join(root, entry.name)).catch(() => {});
			result.removedTemps++;
		}
	}
	return result;
}
