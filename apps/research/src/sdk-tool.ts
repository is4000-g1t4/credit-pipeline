// Typed bridge from a zod-described tool to the Agents SDK `tool()`.
// The argument type of `execute` is inferred from `parameters`, so a spec
// whose `run` disagrees with its schema no longer compiles. (Callers used
// to cast both fields to `never`, which hid exactly that.)
import { tool } from "@openai/agents";
import type { z } from "zod";

export interface SdkToolSpec<S extends z.ZodObject> {
	name: string;
	description: string;
	parameters: S;
	/** Resolves the string the model sees; budget stops resolve, never throw. */
	execute(args: z.infer<S>): Promise<string>;
}

export function sdkTool<S extends z.ZodObject>(spec: SdkToolSpec<S>) {
	// The SDK validates `args` against `parameters` before calling execute,
	// so `z.infer<S>` is exactly what arrives. The widening to `z.ZodObject`
	// is only needed because the SDK's parameter type is a conditional that
	// does not resolve for a generic `S`.
	const parameters: z.ZodObject = spec.parameters;
	return tool({
		name: spec.name,
		description: spec.description,
		parameters,
		execute: (args) => spec.execute(args as z.infer<S>),
	});
}
