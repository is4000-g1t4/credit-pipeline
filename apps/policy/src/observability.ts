// Policy service observability bootstrap. One cached Agent Observability
// client + OTel provider pipeline per process, shared by the answerer and
// corpus embeddings.
import { getObservability, type Observability } from "@credit/agent-observability";

export function policyObservability(): Observability {
	return getObservability("credit-policy");
}
