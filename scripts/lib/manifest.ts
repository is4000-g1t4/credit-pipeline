// Demo manifest loader (SPEC-t17-t18 §2.5): `fixtures/demo/manifest.json`
// is the checked-in source of truth. Seed/verify/case validate the fixture
// version and the canonical hash (manifest minus its own `sha256` field)
// against the code-side expectation below — any drift refuses to run.
// `EXPECTED_MANIFEST_SHA256` must be updated with the manifest; the
// manifest unit test pins them together.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Hex } from "@credit/core";

export const EXPECTED_MANIFEST_VERSION = 1;

/** Canonical hash of the checked-in manifest (see `scripts/lib/manifest.ts`). */
export const EXPECTED_MANIFEST_SHA256 =
	"60cd32d3ce7263e7ced7765f475f3cb9f91ddcbfe362fe0a34c9b4852b72ca63";

export interface ManifestEvidence {
	fixtureKey: string;
	kind: string;
	originalFilename: string;
	documentDate: string | null;
	periodEnd: string | null;
	title: string;
	lines: string[];
}

export interface ManifestTransaction {
	sourceReference: string;
	postedAt: string;
	amountCents: number;
	balanceAfterCents: number;
	currency: string;
	description: string;
	counterparty: string | null;
	category: string;
	returned: boolean;
}

export interface ManifestAccount {
	id: string;
	bankName: string;
	accountType: string;
	maskedNumber: string;
	currency: string;
	openedAt: string;
	status: string;
}

export interface ManifestCase {
	fixtureKey: string;
	type: string;
	product: string;
	amountCents: number;
	termMonths: number;
	purpose: string;
	consents: boolean[];
	documentProcessingConsent: boolean;
	aiResearchConsent: boolean;
	contextAnalysisConsent: boolean;
	identity: Record<string, unknown>;
	sme?: Record<string, unknown>;
	individual?: Record<string, unknown>;
	attach: string[];
	staleCopies: string[];
}

export interface ManifestPersona {
	email: string;
	fullName: string;
	role: string;
	newUser: boolean;
	profile: {
		segment: string;
		customerSince: string;
		kycStatus: string;
		kycVerifiedAt: string | null;
		kycExpiresAt: string | null;
		identity: Record<string, unknown>;
		business: Record<string, unknown> | null;
	};
	accounts: ManifestAccount[];
	transactions: ManifestTransaction[];
	evidence: ManifestEvidence[];
	freshEvidence: ManifestEvidence[];
	case: ManifestCase;
	expectedBlockers: Record<string, string[]>;
	expectedSignals: string[];
	expectedFindings: Array<{ kind: string; field: string; status: string }>;
}

export interface DemoManifest {
	version: number;
	demoAsOf: string;
	sha256: string;
	notes: string;
	personas: Record<string, ManifestPersona>;
}

export function manifestPath(): string {
	return join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"fixtures",
		"demo",
		"manifest.json",
	);
}

/** Hash over the canonical manifest minus its own `sha256` field, so the
 * checked-in file can carry the hash without circularity. */
export function manifestHash(manifest: DemoManifest): string {
	const { sha256: _ignored, ...rest } = manifest;
	return sha256Hex(canonicalJson(rest));
}

export function loadManifest(path: string = manifestPath()): DemoManifest {
	const raw = readFileSync(path, "utf8");
	return JSON.parse(raw) as DemoManifest;
}

/** Fail closed on version or hash drift. */
export function assertManifest(manifest: DemoManifest): { version: number; hash: string } {
	if (manifest.version !== EXPECTED_MANIFEST_VERSION) {
		throw new Error(
			`demo manifest version ${manifest.version} != expected ${EXPECTED_MANIFEST_VERSION}`,
		);
	}
	const hash = manifestHash(manifest);
	if (hash !== EXPECTED_MANIFEST_SHA256) {
		throw new Error(
			`demo manifest hash mismatch: file carries ${manifest.sha256}, computed ${hash}`,
		);
	}
	if (manifest.sha256 !== hash) {
		throw new Error(`demo manifest sha256 field does not match content (${manifest.sha256})`);
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.demoAsOf)) {
		throw new Error(`demo manifest demoAsOf is not YYYY-MM-DD: ${manifest.demoAsOf}`);
	}
	return { version: manifest.version, hash };
}

/** Load + clock + hash gate in one step (replaces the `loadManifest` →
 * `assertFixtureClock` → `assertManifest` preamble every `demo:*` CLI
 * repeats). When `expectedVersion` is set (demo:seed's
 * `DEMO_SEED_VERSION`), the version check runs first, preserving the
 * original error precedence. */
export function loadVerifiedManifest(expectedVersion?: string): DemoManifest {
	const manifest = loadManifest();
	if (expectedVersion !== undefined && expectedVersion !== String(manifest.version)) {
		throw new Error(
			`DEMO_SEED_VERSION ${expectedVersion} != manifest version ${manifest.version}`,
		);
	}
	assertFixtureClock(manifest.demoAsOf, process.env.DEMO_AS_OF);
	assertManifest(manifest);
	return manifest;
}

export function personaOf(manifest: DemoManifest, key: string): ManifestPersona {
	const persona = manifest.personas[key];
	if (!persona) throw new Error(`unknown demo persona: ${key}`);
	return persona;
}

export function demoAsOfDate(manifest: DemoManifest): Date {
	return new Date(`${manifest.demoAsOf}T00:00:00Z`);
}

/** The service clock (`DEMO_AS_OF`) and the manifest must agree, or
 * fixture freshness and the server checklist diverge silently. */
export function assertFixtureClock(
	manifestDemoAsOf: string,
	envDemoAsOf: string | undefined,
): void {
	if (envDemoAsOf && envDemoAsOf !== manifestDemoAsOf) {
		throw new Error(`DEMO_AS_OF ${envDemoAsOf} != manifest demoAsOf ${manifestDemoAsOf}`);
	}
}
