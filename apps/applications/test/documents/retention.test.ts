// retention unit: hold-blocking predicate, blob-purge reporting, and the
// maintenance timer seam (returns stop(), never keeps a process alive).
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { retentionBlockedBy, startDocumentMaintenance } from "../../src/documents/retention.js";
import { purgeBlob } from "../../src/documents/storage.js";

describe("retentionBlockedBy", () => {
	it("empty holds never block", () => {
		expect(retentionBlockedBy([], "file-1")).toBe(false);
	});

	it("application-wide hold blocks every file", () => {
		const holds = [{ documentFileId: null }];
		expect(retentionBlockedBy(holds, "file-1")).toBe(true);
		expect(retentionBlockedBy(holds, "file-2")).toBe(true);
	});

	it("file-level hold blocks only its file", () => {
		const holds = [{ documentFileId: "file-1" }];
		expect(retentionBlockedBy(holds, "file-1")).toBe(true);
		expect(retentionBlockedBy(holds, "file-2")).toBe(false);
	});

	it("any matching hold among several blocks", () => {
		const holds = [{ documentFileId: "other" }, { documentFileId: null }];
		expect(retentionBlockedBy(holds, "file-1")).toBe(true);
		expect(retentionBlockedBy([{ documentFileId: "a" }, { documentFileId: "b" }], "file-1")).toBe(
			false,
		);
	});
});

describe("purgeBlob", () => {
	it("true when the blob is gone, false when it survives", async () => {
		const root = await mkdtemp(join(tmpdir(), "retention-unit-"));
		try {
			const shard = join(root, "app-1");
			await mkdir(shard, { recursive: true });
			await writeFile(join(shard, "gone.enc"), "x");
			expect(await purgeBlob(root, "app-1/gone.enc")).toBe(true);

			await writeFile(join(shard, "stuck.enc"), "x");
			const failing = async () => {
				throw new Error("disk read-only");
			};
			expect(await purgeBlob(root, "app-1/stuck.enc", failing)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("startDocumentMaintenance", () => {
	it("returns a stop() and never keeps the process alive", () => {
		const logger = { info: vi.fn(), warn: vi.fn() };
		const db = new Proxy(
			{},
			{
				get: () => () => {
					throw new Error("no db in unit test");
				},
			},
		);
		const stop = startDocumentMaintenance({
			// oxlint-disable-next-line no-explicit-any
			db: db as any,
			lockTimeoutMs: 50,
			storageDir: join(tmpdir(), `retention-nope-${Date.now()}`),
			uploadDeadlineMs: 1000,
			storageConfigured: false,
			logger,
			intervalMs: 3_600_000,
		});
		expect(typeof stop).toBe("function");
		stop();
	});
});
