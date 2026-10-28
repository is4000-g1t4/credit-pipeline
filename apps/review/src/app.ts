import {
	checkTemporal,
	createService,
	type Logger,
	type ServiceApp,
	type WorkflowGateway,
} from "@credit/service-kit";
import type { ReviewEnv } from "./env.js";
import { reviewRoutes } from "./routes/review.js";

export interface ReviewDeps {
	env: ReviewEnv;
	gateway: WorkflowGateway;
	logger: Logger;
	fetchImpl?: typeof fetch;
}

/** Test seam: pass fakes for gateway/fetch; the production server wires the real ones. Stateless — no DB. */
export function createApp(deps: ReviewDeps): ServiceApp {
	const routes: ServiceApp = reviewRoutes({
		gateway: deps.gateway,
		applicationsUrl: deps.env.applicationsUrl,
		loansUrl: deps.env.loansUrl,
		researchUrl: deps.env.researchUrl,
		agentsEnabled: deps.env.agentsEnabled,
		caseBriefEnabled: deps.env.caseBriefEnabled,
		caseAssistantEnabled: deps.env.caseAssistantEnabled,
		internalSecret: deps.env.internalSecret,
		fetchImpl: deps.fetchImpl,
	});
	return createService({
		name: "review",
		secret: deps.env.internalSecret,
		logger: deps.logger,
		routes,
		health: async () => ({
			temporal: await checkTemporal(deps.env.temporalAddress),
		}),
	});
}
