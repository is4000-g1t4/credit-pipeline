// Deterministic mock bank (SPEC FR-3.2): inflow/FCF echoes the declared
// figures; 12 synthetic balances derive from the seed hash (stable).
import { createHash } from "node:crypto";
import type { MockOptions } from "./mockBureau.js";

export const BANK_PROVIDER = "mock-bank-v1";
export const BANK_VERSION = "mock-bank-v1";

export interface BankReport {
	provider: string;
	version: string;
	monthlyInflowCents: number;
	monthlyFreeCashFlowCents: number;
	balancesCents: number[];
	accountAgeYears: number;
}

export interface IndividualBankInputs {
	email: string;
	monthlyIncomeCents: number;
	existingDebtCents: number;
	relationshipYears: number;
}

export interface SmeBankInputs {
	email: string;
	annualRevenueCents: number;
	declaredFcfCents: number;
	accountAgeYears: number;
}

/** 12 synthetic balances around the inflow, deterministic per seed. */
export function syntheticBalances(seed: string, monthlyInflowCents: number): number[] {
	const digest = createHash("sha256").update(`mock-bank-v1|${seed}`, "utf8").digest();
	const out: number[] = [];
	for (let i = 0; i < 12; i++) {
		// 40%–159% of inflow, exact integer math.
		const pct = 40 + (digest[i] % 120);
		const scaled = BigInt(monthlyInflowCents) * BigInt(pct);
		const q = scaled / 100n;
		const r = scaled % 100n;
		out.push(Number(q + (r >= 50n ? 1n : 0n)));
	}
	return out;
}

export function mockBankIndividual(inputs: IndividualBankInputs, opts?: MockOptions): BankReport {
	if (opts?.forcedFailure) throw new Error(`${BANK_PROVIDER} forced failure`);
	return {
		provider: BANK_PROVIDER,
		version: BANK_VERSION,
		monthlyInflowCents: inputs.monthlyIncomeCents,
		monthlyFreeCashFlowCents: inputs.monthlyIncomeCents - inputs.existingDebtCents,
		balancesCents: syntheticBalances(inputs.email.toLowerCase(), inputs.monthlyIncomeCents),
		accountAgeYears: inputs.relationshipYears,
	};
}

export function mockBankSme(inputs: SmeBankInputs, opts?: MockOptions): BankReport {
	if (opts?.forcedFailure) throw new Error(`${BANK_PROVIDER} forced failure`);
	const inflow = Math.round(inputs.annualRevenueCents / 12);
	return {
		provider: BANK_PROVIDER,
		version: BANK_VERSION,
		monthlyInflowCents: inflow,
		monthlyFreeCashFlowCents: inputs.declaredFcfCents,
		balancesCents: syntheticBalances(inputs.email.toLowerCase(), inflow),
		accountAgeYears: inputs.accountAgeYears,
	};
}
