import type { Db } from "@credit/db";
import type { Sql } from "postgres";
import {
	checkDb,
	checkOutbox,
	checkTemporal,
	createService,
	type Logger,
	type ServiceApp,
	type WorkflowGateway,
} from "@credit/service-kit";
import type { ApplicationsEnv } from "./env.js";
import { assistRoutes, type AssistConfig, type MemoAgentRunner } from "./assist/index.js";
import { buildDocumentService, configFromEnv, type DocumentAdapters } from "./documents/index.js";
import { documentRoutes } from "./documents/routes.js";
import {
	createDocumentMutationHandler,
	integrityRoutes,
	type IntegrityAgentRunner,
	type IntegrityConfig,
} from "./integrity/index.js";
import { resolveContextConfig, type ContextConfig } from "./context/index.js";
import { type CustomerConfig } from "./customer/index.js";
import { applicationsRoutes } from "./routes/applications.js";
import { customerRoutes } from "./routes/customer.js";
import { intakeRoutes } from "./routes/intake.js";
import { internalRoutes } from "./routes/internal.js";

export interface ApplicationsDeps {
	db: Db;
	sql: Sql;
	env: ApplicationsEnv;
	gateway: WorkflowGateway;
	logger: Logger;
	/** Test seam: fake scanner/OCR + config overrides without touching env. */
	documents?: DocumentAdapters;
	/** Test seam: customer storage root/keys + T17 clock without touching env. */
	customer?: {
		config?: Partial<CustomerConfig>;
		demoMode?: boolean;
		demoAsOf?: Date;
	};
	/** Test seam: T18 context thresholds/window/caps without touching env. */
	context?: Partial<ContextConfig>;
	/** Test seam: research purge callback target without touching env. */
	research?: { url?: string };
	/** Test seam: EN-01/02/03 assist config, clock, research fetch, memo model. */
	assist?: {
		config?: Partial<AssistConfig>;
		memoAgentRunner?: MemoAgentRunner;
		policyClient?: import("./agents/policy-exception/index.js").PolicyClient;
		policyExceptionAgentRunner?: import("./agents/policy-exception/index.js").PolicyExceptionAgentRunner;
		now?: () => Date;
		researchFetchImpl?: typeof fetch;
	};
	/** Test seam: E2 integrity config/runner/clock. */
	integrity?: {
		config?: Partial<IntegrityConfig>;
		agentRunner?: IntegrityAgentRunner;
		now?: () => Date;
	};
}

/** Test seam: pass fakes for gateway/db; the production server wires the real ones. */
export function createApp(deps: ApplicationsDeps): ServiceApp {
	const documentConfig = { ...configFromEnv(deps.env), ...deps.documents?.config };
	// T17 customer evidence root: disjoint from the T01 app root — the
	// orphan sweep below only ever receives the app root (D2 adds the
	// separate customer sweep; sharing one root would delete evidence).
	const customerConfig: CustomerConfig = {
		storageDir: deps.env.customer.storageDir,
		encryptionKey: documentConfig.encryptionKey,
		keyId: documentConfig.keyId,
		previousKeys: documentConfig.previousKeys,
		retentionDays: deps.env.customer.retentionDays,
		lockTimeoutMs: documentConfig.lockTimeoutMs,
		...deps.customer?.config,
	};
	const t17 = {
		demoMode: deps.customer?.demoMode ?? deps.env.demo.mode,
		demoAsOf: deps.customer?.demoAsOf ?? deps.env.demo.asOf,
		confirmationKey: deps.env.internalSecret,
	};
	const routes: ServiceApp = applicationsRoutes({
		db: deps.db,
		gateway: deps.gateway,
		logger: deps.logger,
		documentsEnabled: documentConfig.featureEnabled,
		fraudReviewEnabled:
			deps.integrity?.config?.fraudReviewEnabled ?? deps.env.integrity.fraudReviewEnabled,
	});
	routes.route(
		"/",
		intakeRoutes({
			db: deps.db,
			gateway: deps.gateway,
			logger: deps.logger,
			t17,
			researchUrl: deps.research?.url ?? deps.env.researchUrl,
			internalSecret: deps.env.internalSecret,
		}),
	);
	routes.route(
		"/",
		customerRoutes({ db: deps.db, demoMode: t17.demoMode, demoAsOf: t17.demoAsOf }),
	);
	routes.route(
		"/",
		internalRoutes({
			db: deps.db,
			sql: deps.sql,
			documents: {
				storageDir: documentConfig.storageDir,
				lockTimeoutMs: documentConfig.lockTimeoutMs,
			},
			integrity: {
				fraudReviewEnabled:
					deps.integrity?.config?.fraudReviewEnabled ?? deps.env.integrity.fraudReviewEnabled,
			},
			context: resolveContextConfig(deps.env, deps.context),
			policyRuleContext: {
				enabled: deps.env.assist.enabled && deps.env.assist.policyExceptionEnabled,
				secret: deps.env.assist.policyRuleContextSecret,
			},
		}),
	);
	const assistRuntime = {
		config: { ...deps.env.assist, ...deps.assist?.config },
		documentsEnabled: documentConfig.featureEnabled,
		memoAgentRunner: deps.assist?.memoAgentRunner,
		policyClient: deps.assist?.policyClient,
		policyExceptionAgentRunner: deps.assist?.policyExceptionAgentRunner,
		now: deps.assist?.now ?? (() => new Date()),
		researchFetchImpl: deps.assist?.researchFetchImpl,
	};
	routes.route(
		"/",
		assistRoutes({
			db: deps.db,
			runtime: assistRuntime,
			logger: deps.logger,
		}),
	);
	const documentService = buildDocumentService(deps.db, documentConfig, deps.documents ?? {});
	const integrityRuntime = {
		config: { ...deps.env.integrity, ...deps.integrity?.config },
		documentsEnabled: documentConfig.featureEnabled,
		agentRunner: deps.integrity?.agentRunner ?? null,
		now: deps.integrity?.now ?? (() => new Date()),
	};
	const integrityDeps = {
		db: deps.db,
		config: integrityRuntime.config,
		runner: integrityRuntime.agentRunner,
		logger: deps.logger,
		now: integrityRuntime.now,
	};
	routes.route(
		"/",
		integrityRoutes({
			db: deps.db,
			runtime: integrityRuntime,
			logger: deps.logger,
		}),
	);
	routes.route(
		"/",
		documentRoutes({
			db: deps.db,
			config: documentConfig,
			service: documentService,
			logger: deps.logger,
			customer: customerConfig,
			t17,
			appRetentionDays: documentConfig.retentionDays,
			onDocumentMutation: createDocumentMutationHandler(integrityDeps),
		}),
	);
	return createService({
		name: "applications",
		secret: deps.env.internalSecret,
		logger: deps.logger,
		routes,
		// T01 upload path only (multipart 10 MB + overhead); every other
		// route keeps service-kit's 100 KB JSON bound.
		bodyLimitOverrides: [
			{
				method: "POST",
				pathPattern: /^\/api\/applications\/[^/]+\/documents$/,
				maxBytes: deps.env.documentUploadMaxBytes,
			},
		],
		health: async () => ({
			db: await checkDb(() => deps.sql`SELECT 1`),
			temporal: await checkTemporal(deps.env.temporalAddress),
			outbox: await checkOutbox(
				() =>
					deps.sql`SELECT count(*) FILTER (WHERE dead_lettered_at IS NULL)::int AS backlog,
					count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead
					FROM outbox_events WHERE published_at IS NULL` as Promise<
						Array<{ backlog: number; dead: number }>
					>,
			),
		}),
	});
}
