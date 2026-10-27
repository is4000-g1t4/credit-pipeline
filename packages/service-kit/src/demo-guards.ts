// Demo guard rails (SPEC-t17-t18 §2.5/§4): every mutating demo script and
// the applications boot path enforce the same three rules — DEMO_MODE on,
// never production, storage roots + volumes from explicit demo allowlists.
// Pure (no env reads) except resolveWorkspacePath, which only reads the cwd;
// callers pass values in so unit tests stay compose-free.
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
export class DemoGuardError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DemoGuardError";
	}
}

/** Refuse unless `DEMO_MODE=true` and `NODE_ENV` is not production. */
export function assertDemoMutable(input: { demoMode: boolean; nodeEnv: string }): void {
	if (!input.demoMode) {
		throw new DemoGuardError("refusing: DEMO_MODE is not true");
	}
	if (input.nodeEnv === "production") {
		throw new DemoGuardError("refusing: NODE_ENV is production");
	}
}

/** Full boot gate: the mutable check plus reset-allowed-never-in-production. */
export function assertDemoBoot(input: {
	demoMode: boolean;
	nodeEnv: string;
	demoResetAllowed: boolean;
	documentStorageDir: string;
	customerStorageDir: string;
}): void {
	if (input.demoResetAllowed && input.nodeEnv === "production") {
		throw new DemoGuardError("refusing: DEMO_RESET_ALLOWED in production");
	}
	// Sweep isolation is production-critical too: equal or nested blob roots
	// would let the T01 app orphan sweep touch customer evidence.
	assertStorageRootsDisjoint(input.documentStorageDir, input.customerStorageDir);
	if (!input.demoMode) return;
	assertDemoDocumentRoot(input.documentStorageDir, "DOCUMENT_STORAGE_DIR");
	assertDemoCustomerRoot(input.customerStorageDir, "CUSTOMER_STORAGE_DIR");
}

// Demo storage roots: host checkouts keep blobs under the workspace
// `.data/` tree, the microservices overlay under `/data/`. Exact canonical
// roots only — subpaths, suffix tricks (`/evil/.data/documents`), and
// arbitrary absolute paths are refused, because reset wipes these roots.
const DEMO_DOCUMENT_REL = ".data/documents";
const DEMO_CUSTOMER_REL = ".data/customer-documents";
const DEMO_DOCUMENT_CONTAINER = "/data/documents";
const DEMO_CUSTOMER_CONTAINER = "/data/customer-documents";

function normalizedRoot(root: string): string {
	return root.replace(/\\/g, "/").replace(/\/+$/, "");
}

function samePath(a: string, b: string): boolean {
	// Windows paths are case-insensitive (drive-letter case especially).
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Workspace root (dir holding pnpm-workspace.yaml), forward slashes. */
function workspaceRootDir(): string | null {
	let dir = process.cwd();
	for (;;) {
		try {
			if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
				return dir.replace(/\\/g, "/").replace(/\/+$/, "");
			}
		} catch {
			// A stat failure is not a veto — keep walking up.
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function rootMatches(root: string, rel: string, container: string): boolean {
	const normalized = normalizedRoot(root.trim());
	if (normalized === "" || normalized.includes("..") || normalized.includes("\0")) return false;
	if (samePath(normalized, rel) || samePath(normalized, container)) return true;
	// A host absolute path is the same allowlisted root only when it is
	// exactly the workspace-anchored dir (scripts pass absolute paths
	// after resolveWorkspacePath).
	const workspace = workspaceRootDir();
	return workspace !== null && samePath(normalized, `${workspace}/${rel}`);
}

/** True only for the canonical host workspace roots (reset `rm`s these;
 * container roots are cleared via Docker volumes, never `rm`). */
export function isDemoHostRoot(root: string): boolean {
	const normalized = normalizedRoot(root.trim());
	if (normalized === "" || normalized.includes("..") || normalized.includes("\0")) return false;
	const workspace = workspaceRootDir();
	for (const rel of [DEMO_DOCUMENT_REL, DEMO_CUSTOMER_REL] as const) {
		if (samePath(normalized, rel)) return true;
		if (workspace !== null && samePath(normalized, `${workspace}/${rel}`)) return true;
	}
	return false;
}

/** True only for the allowlisted demo blob roots (exact canonical roots). */
export function isDemoStorageRoot(root: string): boolean {
	return (
		rootMatches(root, DEMO_DOCUMENT_REL, DEMO_DOCUMENT_CONTAINER) ||
		rootMatches(root, DEMO_CUSTOMER_REL, DEMO_CUSTOMER_CONTAINER)
	);
}

/** True only for the allowlisted demo APPLICATION blob root. */
export function isDemoDocumentRoot(root: string): boolean {
	return rootMatches(root, DEMO_DOCUMENT_REL, DEMO_DOCUMENT_CONTAINER);
}

/** True only for the allowlisted demo CUSTOMER blob root. */
export function isDemoCustomerRoot(root: string): boolean {
	return rootMatches(root, DEMO_CUSTOMER_REL, DEMO_CUSTOMER_CONTAINER);
}

export function assertDemoStorageRoot(root: string, name: string): void {
	if (!isDemoStorageRoot(root)) {
		throw new DemoGuardError(`refusing: ${name} is not a demo root: ${root}`);
	}
}

export function assertDemoDocumentRoot(root: string, name: string): void {
	if (!isDemoDocumentRoot(root)) {
		throw new DemoGuardError(`refusing: ${name} is not a demo application root: ${root}`);
	}
}

export function assertDemoCustomerRoot(root: string, name: string): void {
	if (!isDemoCustomerRoot(root)) {
		throw new DemoGuardError(`refusing: ${name} is not a demo customer root: ${root}`);
	}
}

/** Blob-root isolation: equal or nested roots would let one sweep touch the
 * other's blobs. Enforced at boot in every environment, not just demo. */
export function assertStorageRootsDisjoint(documentDir: string, customerDir: string): void {
	const a = normalizedRoot(documentDir.trim());
	const b = normalizedRoot(customerDir.trim());
	if (a === "" || b === "" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
		throw new DemoGuardError(
			`refusing: blob roots are not disjoint: ${documentDir} vs ${customerDir}`,
		);
	}
}

/** Volumes `demo:reset` may remove. Blob data lives on the host `.data/`
 * bind-mounts (cleared by the fs step), so only the stateful infra volumes
 * are listed; `svc-node-modules` is never listed — the installer volume is
 * preserved across resets. */
export const DEMO_RESET_VOLUMES = ["pgdata", "kafka-data"] as const;

export function assertDemoVolume(volume: string): void {
	if (!(DEMO_RESET_VOLUMES as readonly string[]).includes(volume)) {
		throw new DemoGuardError(`refusing: volume is not demo-resettable: ${volume}`);
	}
}

/** Destructive reset needs every guard plus an explicit `--yes` and an
 * explicit allow flag — production is refused even with `--yes`. */
export function assertDemoResetAllowed(input: {
	demoMode: boolean;
	nodeEnv: string;
	demoResetAllowed: boolean;
	confirmed: boolean;
}): void {
	assertDemoMutable(input);
	if (!input.demoResetAllowed) {
		throw new DemoGuardError("refusing: DEMO_RESET_ALLOWED is not true");
	}
	if (!input.confirmed) {
		throw new DemoGuardError("refusing: demo:reset needs an explicit --yes");
	}
}

/** Anchor a storage dir at the workspace root: services run with
 * cwd=package dir under `pnpm --filter` while scripts run with cwd=root —
 * a bare relative `.data/...` root would otherwise point at two different
 * trees and cross-process flows (seed writes, service reuse reads) break.
 * Absolute values pass through untouched. */
export function resolveWorkspacePath(value: string): string {
	const trimmed = value.trim();
	if (trimmed === "" || isAbsolute(trimmed)) return value;
	let dir = process.cwd();
	for (;;) {
		try {
			if (existsSync(join(dir, "pnpm-workspace.yaml"))) return join(dir, trimmed);
		} catch {
			// A stat failure is not a veto — keep walking up.
		}
		const parent = dirname(dir);
		if (parent === dir) return join(process.cwd(), trimmed);
		dir = parent;
	}
}
