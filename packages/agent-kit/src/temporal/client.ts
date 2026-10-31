// Starting agent runs from a service API process. Bun-safe: imports only
// @temporalio/client (the worker SDK needs Node and lives in worker.ts).
import {
	Client,
	Connection,
	WorkflowExecutionAlreadyStartedError,
	WorkflowIdReusePolicy,
} from "@temporalio/client";
import { AGENT_RUN_WORKFLOW, type AgentRunInput } from "./types.js";

/**
 * Deterministic workflow id: one workflow per (kind, run, claim token). A
 * re-issued start for the same token (crash between commit and start) is a
 * no-op; a new token (new context-retry stage, etc.) is a new workflow.
 */
export function agentRunWorkflowId(input: Pick<AgentRunInput, "kind" | "runId" | "token">): string {
	return `${input.kind}:${input.runId}:${input.token}`;
}

export interface AgentRunStarter {
	/** Starts the run's workflow; `started: false` when it already exists. */
	start(input: AgentRunInput): Promise<{ started: boolean; workflowId: string }>;
	close(): Promise<void>;
}

export interface AgentRunStarterOptions {
	address: string;
	namespace?: string;
	taskQueue: string;
	/** Test seam: an existing client. */
	client?: Client;
}

/** Lazily connects; a failed connect is retried on the next start. */
export function createAgentRunStarter(opts: AgentRunStarterOptions): AgentRunStarter {
	let connecting: Promise<{ client: Client; connection: Connection | null }> | null = null;
	const getClient = (): Promise<{ client: Client; connection: Connection | null }> => {
		if (opts.client) return Promise.resolve({ client: opts.client, connection: null });
		connecting ??= (async () => {
			const connection = await Connection.connect({ address: opts.address });
			return {
				client: new Client({ connection, namespace: opts.namespace ?? "default" }),
				connection,
			};
		})().catch((err: unknown) => {
			connecting = null;
			throw err;
		});
		return connecting;
	};
	return {
		async start(input) {
			const workflowId = agentRunWorkflowId(input);
			const { client } = await getClient();
			try {
				await client.workflow.start(AGENT_RUN_WORKFLOW, {
					taskQueue: opts.taskQueue,
					workflowId,
					args: [input],
					workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
				});
				return { started: true, workflowId };
			} catch (err) {
				if (err instanceof WorkflowExecutionAlreadyStartedError) {
					return { started: false, workflowId };
				}
				throw err;
			}
		},
		async close() {
			if (!connecting || opts.client) return;
			const { connection } = await connecting.catch(() => ({ connection: null }));
			await connection?.close();
			connecting = null;
		},
	};
}
