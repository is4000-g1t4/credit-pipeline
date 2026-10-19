// Activity registry: everything the workflows proxy. Explicit map (not
// `export *`) so the workflow↔activity contract reads in one place.
import * as application from "./application.js";
import * as booking from "./booking.js";
import * as data from "./data.js";
import * as decisions from "./decisions.js";
import * as fail from "./fail.js";
import * as monitoring from "./monitoring.js";
import * as policy from "./policy.js";
import * as scoring from "./scoring.js";
import type { Activities } from "./types.js";
import * as verification from "./verification.js";

export const activities: Activities = {
	loadApplicationAndSetProcessing: application.loadApplicationAndSetProcessing,
	loadApplication: application.loadApplication,
	runIdentityCheck: verification.runIdentityCheck,
	runSanctionsCheck: verification.runSanctionsCheck,
	runDocumentCheck: verification.runDocumentCheck,
	fetchBureauReport: data.fetchBureauReport,
	fetchBankData: data.fetchBankData,
	scoreAndPersist: scoring.scoreAndPersist,
	evaluateAndPersistPolicy: policy.evaluateAndPersistPolicy,
	persistDecline: decisions.persistDecline,
	persistCheckOnlyDecline: decisions.persistCheckOnlyDecline,
	persistOfficerDecline: decisions.persistOfficerDecline,
	markPendingReview: decisions.markPendingReview,
	expireReview: decisions.expireReview,
	bookLoan: booking.bookLoan,
	runMonitoring: monitoring.runMonitoring,
	markFailed: fail.markFailed,
};
