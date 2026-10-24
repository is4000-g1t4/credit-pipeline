// scanner unit: fake verdicts, fail-closed unavailable, test-mode gating.
import { describe, expect, it } from "vitest";
import net from "node:net";
import {
	createClamAvScanner,
	createFakeScanner,
	resolveScanner,
	ScannerUnavailable,
} from "../../src/documents/scanner.js";

describe("document scanner", () => {
	it("fake returns canned verdicts and counts calls", async () => {
		const clean = createFakeScanner("clean");
		expect(await clean.scan(Buffer.from("x"))).toBe("clean");
		expect(clean.calls).toBe(1);
		expect(await createFakeScanner("infected").scan(Buffer.from("x"))).toBe("infected");
		await expect(createFakeScanner("unavailable").scan(Buffer.from("x"))).rejects.toBeInstanceOf(
			ScannerUnavailable,
		);
	});

	it("fails closed when no daemon listens", async () => {
		// Bind-then-close: a guaranteed-empty port, never a fixed one that a
		// local daemon could occupy.
		const held = net.createServer();
		await new Promise<void>((resolve) => held.listen(0, "127.0.0.1", resolve));
		const port = (held.address() as net.AddressInfo).port;
		await new Promise<void>((resolve) => held.close(() => resolve()));
		const scanner = createClamAvScanner({ host: "127.0.0.1", port, timeoutMs: 1000 });
		await expect(scanner.scan(Buffer.from("%PDF-"))).rejects.toBeInstanceOf(ScannerUnavailable);
	});

	it("accepts clamd's NUL-terminated zINSTREAM reply", async () => {
		const server = net.createServer((socket) => {
			socket.once("data", () => {
				socket.write("stream: OK\0"); // z-prefix: no trailing newline
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as net.AddressInfo).port;
		try {
			const scanner = createClamAvScanner({ host: "127.0.0.1", port, timeoutMs: 3000 });
			await expect(scanner.scan(Buffer.from("%PDF-"))).resolves.toBe("clean");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("test mode resolves only under NODE_ENV=test with an injected fake", () => {
		const fake = createFakeScanner("clean");
		const prev = process.env.NODE_ENV;
		try {
			process.env.NODE_ENV = "production";
			expect(() => resolveScanner({ mode: "test", host: "", port: 0, timeoutMs: 1 })).toThrow(
				ScannerUnavailable,
			);
		} finally {
			process.env.NODE_ENV = prev;
		}
		expect(
			resolveScanner({ mode: "test", host: "", port: 0, timeoutMs: 1, testAdapter: fake }),
		).toBe(fake);
		expect(() =>
			resolveScanner({ mode: "clamd", host: "127.0.0.1", port: 3310, timeoutMs: 1 }),
		).not.toThrow();
	});
});
