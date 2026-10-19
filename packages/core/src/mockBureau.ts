// Deterministic mock bureau (SPEC FR-3.1): fixed demo profiles by email,
// hash-derived fallback on sha256(lower(email)|nationalId|registrationNumber).
import { createHash } from "node:crypto";

export const BUREAU_PROVIDER = "mock-bureau-v1";
export const BUREAU_VERSION = "mock-bureau-v1";

export interface BureauReport {
	provider: string;
	version: string;
	bureauScore: number;
	delinquencies: number;
	utilizationPct: number;
	inquiries6m: number;
}

export interface BureauIdentity {
	email: string;
	nationalId?: string;
	registrationNumber?: string;
}

export interface MockOptions {
	/** Test hook: throw instead of returning data (FR-3.4). */
	forcedFailure?: boolean;
}

interface FixedProfile {
	score: number;
	delinquencies: number;
	utilizationPct: number;
	inquiries6m: number;
}

const FIXED_PROFILES: Record<string, FixedProfile> = {
	"maria@example.com": {
		score: 742,
		delinquencies: 0,
		utilizationPct: 28,
		inquiries6m: 1,
	},
	"alex@example.com": {
		score: 638,
		delinquencies: 1,
		utilizationPct: 65,
		inquiries6m: 2,
	},
	"sam@example.com": {
		score: 528,
		delinquencies: 3,
		utilizationPct: 88,
		inquiries6m: 5,
	},
	"tomas@cafe-aurora.example": {
		score: 711,
		delinquencies: 1,
		utilizationPct: 41,
		inquiries6m: 2,
	},
	"lena@bakery.example": {
		score: 780,
		delinquencies: 0,
		utilizationPct: 22,
		inquiries6m: 0,
	},
};

export function bureauSeedKey(identity: BureauIdentity): string {
	return `${identity.email.toLowerCase()}|${identity.nationalId ?? ""}|${identity.registrationNumber ?? ""}`;
}

export function mockBureau(identity: BureauIdentity, opts?: MockOptions): BureauReport {
	if (opts?.forcedFailure) throw new Error(`${BUREAU_PROVIDER} forced failure`);
	const fixed = FIXED_PROFILES[identity.email.toLowerCase()];
	if (fixed) {
		return {
			provider: BUREAU_PROVIDER,
			version: BUREAU_VERSION,
			bureauScore: fixed.score,
			delinquencies: fixed.delinquencies,
			utilizationPct: fixed.utilizationPct,
			inquiries6m: fixed.inquiries6m,
		};
	}
	const digest = createHash("sha256").update(bureauSeedKey(identity), "utf8").digest();
	return {
		provider: BUREAU_PROVIDER,
		version: BUREAU_VERSION,
		bureauScore: 520 + ((digest[0] * 256 + digest[1]) % 281), // 520–800
		delinquencies: digest[2] % 4, // 0–3
		utilizationPct: 10 + (digest[3] % 81), // 10–90
		inquiries6m: digest[4] % 6, // 0–5
	};
}
