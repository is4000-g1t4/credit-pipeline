// @credit/db — scrypt password hashing (node:crypto only, no new deps).
// Format: scrypt$N$r$p$saltHex$hashHex. Verify is constant-time.
import { randomBytes, type ScryptOptions, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 32;
const SALTLEN = 16;

// promisify() would bind the 3-arg overload; this keeps the options arg.
function scryptAsync(
	password: string,
	salt: Buffer,
	keylen: number,
	options: ScryptOptions,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scryptCb(password, salt, keylen, options, (err, derivedKey) => {
			if (err) reject(err);
			else resolve(derivedKey as Buffer);
		});
	});
}

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(SALTLEN);
	const hash = await scryptAsync(password, salt, KEYLEN, { N, r, p });
	return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") return false;
	const [, n, rr, pp, saltHex, hashHex] = parts;
	const salt = Buffer.from(saltHex, "hex");
	const expected = Buffer.from(hashHex, "hex");
	if (salt.length !== SALTLEN || expected.length !== KEYLEN) return false;
	const nNum = Number(n);
	const rNum = Number(rr);
	const pNum = Number(pp);
	if (![nNum, rNum, pNum].every(Number.isInteger)) return false;
	let actual: Buffer;
	try {
		actual = await scryptAsync(password, salt, KEYLEN, {
			N: nNum,
			r: rNum,
			p: pNum,
			maxmem: 64 * 1024 * 1024,
		});
	} catch {
		return false; // out-of-range N/r/p (ERR_CRYPTO_INVALID_SCRYPT_PARAMS)
	}
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
