// Worker logger (SPEC FR-11.7): same pino factory the services use.
import { createLogger } from "@credit/service-kit";

export const logger = createLogger("worker");
