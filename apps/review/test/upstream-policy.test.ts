// mapUpstreamError unit test (compose-free): 5xx scrubs to 502 BAD_GATEWAY,
// 4xx passes status/code through.
import { describe, expect, it } from "vitest";
import { mapUpstreamError } from "../src/routes/review.js";

describe("mapUpstreamError", () => {
	it("maps 5xx to 502 BAD_GATEWAY, dropping the upstream code", () => {
		expect(mapUpstreamError(500, "RESEARCH_FAILED", "boom")).toEqual({
			status: 502,
			code: "BAD_GATEWAY",
			message: "upstream service unavailable",
		});
		expect(mapUpstreamError(503)).toEqual({
			status: 502,
			code: "BAD_GATEWAY",
			message: "upstream service unavailable",
		});
	});

	it("passes 4xx status/code through", () => {
		expect(mapUpstreamError(404, "NOT_FOUND", "not found")).toEqual({
			status: 404,
			code: "NOT_FOUND",
			message: "not found",
		});
		expect(mapUpstreamError(409, "RETRY_UNAVAILABLE", "no retry left")).toEqual({
			status: 409,
			code: "RETRY_UNAVAILABLE",
			message: "no retry left",
		});
		expect(mapUpstreamError(404)).toEqual({
			status: 404,
			code: "BAD_GATEWAY",
			message: "upstream service unavailable",
		});
	});
});
