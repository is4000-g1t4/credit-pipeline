// Affordability (SPEC FR-4.1): display ratios. Policy boundaries use the
// integer rules in money.ts — never these floats.
export type AffordabilityInputs =
	| {
			kind: "individual";
			monthlyIncomeCents: number;
			existingDebtCents: number;
			newPaymentCents: number;
	  }
	| {
			kind: "sme";
			monthlyFreeCashFlowCents: number;
			existingDebtServiceCents: number;
			newPaymentCents: number;
	  };

export type AffordabilityResult =
	| { kind: "individual"; newPaymentCents: number; dti: number }
	| { kind: "sme"; newPaymentCents: number; dscr: number };

export function computeAffordability(inputs: AffordabilityInputs): AffordabilityResult {
	if (inputs.kind === "individual") {
		return {
			kind: "individual",
			newPaymentCents: inputs.newPaymentCents,
			dti: (inputs.existingDebtCents + inputs.newPaymentCents) / inputs.monthlyIncomeCents,
		};
	}
	return {
		kind: "sme",
		newPaymentCents: inputs.newPaymentCents,
		dscr:
			inputs.monthlyFreeCashFlowCents / (inputs.newPaymentCents + inputs.existingDebtServiceCents),
	};
}
