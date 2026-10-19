// Monitoring schedule bootstrap (SPEC FR-6.5): idempotently create-or-update
// the `monitoring` Temporal Schedule (every 5 min, overlap SKIP) at worker
// start, so `docker compose up` + worker start self-provisions. Restart
// behaviour: describe-then-update when the schedule exists (a second
// bootstrap updates in place — still one schedule), create on
// ScheduleNotFoundError, and update-in-place if create races an existing
// one (ScheduleAlreadyRunning).
import { MONITORING_SCHEDULE_ID, monitoringWorkflowName, TASK_QUEUE } from "@credit/core";
import {
	Client,
	Connection,
	ScheduleAlreadyRunning,
	ScheduleNotFoundError,
	ScheduleOverlapPolicy,
} from "@temporalio/client";

export type ScheduleBootstrapOutcome = "created" | "updated";

function scheduleDefinition() {
	return {
		spec: { intervals: [{ every: "5 minutes" as const }] },
		action: {
			type: "startWorkflow" as const,
			workflowType: monitoringWorkflowName,
			taskQueue: TASK_QUEUE,
			args: [{ manual: false }],
		},
		policies: { overlap: ScheduleOverlapPolicy.SKIP },
	};
}

/** Idempotent bootstrap. Pass a Client in tests; otherwise connects using
 * TEMPORAL_ADDRESS and closes the connection before returning. */
export async function bootstrapMonitoringSchedule(
	client?: Client,
	address?: string,
): Promise<ScheduleBootstrapOutcome> {
	let connection: Connection | null = null;
	let active: Client;
	if (client) {
		active = client;
	} else {
		connection = await Connection.connect({
			address: address ?? process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
		});
		active = new Client({ connection });
	}
	const c = active;
	const definition = scheduleDefinition();
	try {
		try {
			const handle = c.schedule.getHandle(MONITORING_SCHEDULE_ID);
			const previous = await handle.describe();
			await handle.update(() => ({ ...definition, state: previous.state }));
			console.log(`worker: monitoring schedule '${MONITORING_SCHEDULE_ID}' updated in place`);
			return "updated";
		} catch (err) {
			if (!(err instanceof ScheduleNotFoundError)) throw err;
			try {
				await c.schedule.create({
					scheduleId: MONITORING_SCHEDULE_ID,
					...definition,
				});
				console.log(`worker: monitoring schedule '${MONITORING_SCHEDULE_ID}' created (every 5m)`);
				return "created";
			} catch (createErr) {
				if (!(createErr instanceof ScheduleAlreadyRunning)) throw createErr;
				const previous = await c.schedule.getHandle(MONITORING_SCHEDULE_ID).describe();
				await c.schedule
					.getHandle(MONITORING_SCHEDULE_ID)
					.update(() => ({ ...definition, state: previous.state }));
				console.log(
					`worker: monitoring schedule '${MONITORING_SCHEDULE_ID}' updated in place (won create race)`,
				);
				return "updated";
			}
		}
	} finally {
		await connection?.close();
	}
}
