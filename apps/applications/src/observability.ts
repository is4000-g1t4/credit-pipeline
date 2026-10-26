// Applications service observability bootstrap. One cached Agent
// Observability client + OTel provider pipeline per process, shared by the
// memo writer and document-integrity agent.
import { getObservability, type Observability } from "@credit/agent-observability";

export function applicationObservability(): Observability {
	return getObservability("credit-applications");
}
