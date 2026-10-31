// The policy-review response validator: the policy service's reply is
// untrusted JSON until it parses against this strict schema. Shape drift
// fails the stage (`policy case response shape drift`); nothing is repaired.
import { z } from "zod";

const uuid = z.uuid();

export const caseResponseSchema = z
	.object({
		status: z.enum(["succeeded", "no_match", "needs_policy_owner", "budget_exceeded", "failed"]),
		summary: z.string().optional(),
		items: z.array(
			z.object({
				ref: z.string(),
				explanationSegments: z.array(
					z.object({ text: z.string(), citationIndexes: z.array(z.number()) }),
				),
				citations: z.array(
					z.object({
						policyKey: z.string(),
						policyVersionId: uuid,
						sectionId: z.string(),
						heading: z.string(),
						version: z.string(),
						effectiveFrom: z.string(),
						effectiveTo: z.string().nullable(),
						quote: z.string(),
						drawerToken: z.string(),
					}),
				),
				confidence: z.enum(["low", "medium", "high"]),
			}),
		),
		limitations: z.array(z.string()),
		usage: z
			.object({
				inputTokens: z.number().optional(),
				outputTokens: z.number().optional(),
				costUsd: z.number().optional(),
				model: z.string().optional(),
			})
			.optional(),
	})
	.strict();
