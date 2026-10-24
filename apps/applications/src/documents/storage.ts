// T01 encrypted blob store (SPEC-t01-t02 §6.5): server-generated
// `<applicationId>/<fileId>.enc` under DOCUMENT_STORAGE_DIR (0700).
// Writes go to a ciphertext-only temp file (0600, same directory),
// fsync file+dir, then rename. Every resolve rejects absolute paths,
// `..` escapes, and symlink escapes (realpath recheck).
import { constants, promises as fs } from "node:fs";
import * as path from "node:path";
import { decryptDocument, sha256Hex } from "./crypto.js";

export function storageKeyFor(applicationId: string, fileId: string): string {
	return `${applicationId}/${fileId}.enc`;
}

/** Resolve a server-generated key under `root`; throw on any escape. */
export async function resolveStoragePath(root: string, key: string): Promise<string> {
	if (path.isAbsolute(key)) throw new Error("invalid storage key");
	const normalized = path.normalize(key);
	if (normalized === ".." || normalized.startsWith(`..${path.sep}`) || normalized.includes("\0")) {
		throw new Error("invalid storage key");
	}
	const rootReal = await fs.realpath(root);
	const joined = path.join(rootReal, normalized);
	const parent = path.dirname(joined);
	await fs.mkdir(parent, { recursive: true, mode: 0o700 });
	// Symlink escape: the real parent must still sit under the real root.
	const parentReal = await fs.realpath(parent);
	if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) {
		throw new Error("invalid storage key");
	}
	return path.join(parentReal, path.basename(joined));
}

export async function ensureStorageDir(root: string): Promise<string> {
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	await fs.chmod(root, 0o700);
	return fs.realpath(root);
}

function randomSuffix(): string {
	return `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/** Ciphertext-only atomic write; temp file is unlinked on any failure. */
export async function writeEncryptedFile(
	root: string,
	key: string,
	ciphertext: Buffer,
): Promise<void> {
	const dest = await resolveStoragePath(root, key);
	const tmp = `${dest}.tmp-${randomSuffix()}`;
	let handle: fs.FileHandle | null = null;
	try {
		handle = await fs.open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		await handle.chmod(0o600);
		await handle.writeFile(ciphertext);
		await handle.sync();
		await handle.close();
		handle = null;
		const dir = await fs.open(path.dirname(dest), "r");
		try {
			await fs.rename(tmp, dest);
			// Directory fsync is best-effort: Windows rejects it (EPERM)
			// while Linux persists the rename entry.
			await dir.sync().catch(() => {});
		} finally {
			await dir.close();
		}
	} finally {
		if (handle) await handle.close().catch(() => {});
		await fs.unlink(tmp).catch(() => {});
	}
}

export async function readEncryptedFile(root: string, key: string): Promise<Buffer> {
	const dest = await resolveStoragePath(root, key);
	return fs.readFile(dest);
}

export async function deleteBlob(root: string, key: string): Promise<void> {
	try {
		await fs.unlink(await resolveStoragePath(root, key));
	} catch {
		// Best-effort: the orphan sweep retries later.
	}
}

/** Best-effort purge that reports success: the storage helper swallows
 * errors, so verify the bytes are actually gone afterwards. A throwing
 * deleter (tests) also reports false — the caller keeps a retry marker. */
export async function purgeBlob(
	root: string,
	key: string,
	del: (root: string, key: string) => Promise<void> = deleteBlob,
): Promise<boolean> {
	try {
		await del(root, key);
	} catch {
		return false;
	}
	try {
		await fs.stat(await resolveStoragePath(root, key));
		return false;
	} catch {
		return true;
	}
}

export interface OpenBlobInput {
	root: string;
	storageKey: string;
	nonceB64: string;
	tagB64: string;
	fileId: string;
	applicationId: string;
	cryptoVersion: string;
	keyId: string;
	keys: Map<string, Buffer>;
	expectedSha256: string;
}

/** Read → decrypt → hash-verify. Any failure throws (fail closed). */
export async function openAndVerifyBlob(input: OpenBlobInput): Promise<Buffer> {
	const ciphertext = await readEncryptedFile(input.root, input.storageKey);
	const plaintext = decryptDocument({
		ciphertext,
		nonceB64: input.nonceB64,
		tagB64: input.tagB64,
		fileId: input.fileId,
		applicationId: input.applicationId,
		cryptoVersion: input.cryptoVersion,
		keyId: input.keyId,
		keys: input.keys,
	});
	if (sha256Hex(plaintext) !== input.expectedSha256) throw new Error("hash mismatch");
	return plaintext;
}

/** Attachment disposition with an ASCII-only server-chosen name (never the
 * client filename — audit/logs must not carry it either). */
export function contentDispositionFor(fileId: string, mimeType: string): string {
	const ext = mimeType === "application/pdf" ? "pdf" : mimeType === "image/png" ? "png" : "jpg";
	return `attachment; filename="document-${fileId}.${ext}"`;
}
