// EN-02 retention loop: boot + daily tombstone sweep. The DB row is never
// hard-deleted; an active legal hold blocks the tombstone. Wired only from
// server.ts so createApp tests stay timer-free.
import type { Db } from "@credit/db/applications";
import type { Logger } from "@credit/service-kit";
import { runArtifactRetention } from "./artifacts.js";

export interface ArtifactRetentionDeps {
	db: Db;
	logger?: Pick<Logger, "info" | "warn">;
	intervalMs?: number;
	now?: () => Date;
	/** E2: keep briefs while a fraud review is active. */
	fraudReviewEnabled?: boolean;
}

export async function runArtifactRetentionOnce(
	deps: ArtifactRetentionDeps,
): Promise<{ checked: number; deleted: number; skippedHolds: number }> {
	return runArtifactRetention(deps.db, {
		now: deps.now?.(),
		fraudReviewEnabled: deps.fraudReviewEnabled,
	});
}

export function startArtifactRetention(deps: ArtifactRetentionDeps): () => void {
	const run = async (): Promise<void> => {
		try {
			const result = await runArtifactRetentionOnce(deps);
			deps.logger?.info(result, "artifact retention");
		} catch {
			deps.logger?.warn({ code: "ARTIFACT_RETENTION_FAILED" }, "artifact retention failed");
		}
	};
	void run();
	const interval = setInterval(() => {
		void run();
	}, deps.intervalMs ?? 86_400_000);
	if (typeof (interval as unknown as { unref?: () => void }).unref === "function") {
		(interval as unknown as { unref: () => void }).unref();
	}
	return () => clearInterval(interval);
}
