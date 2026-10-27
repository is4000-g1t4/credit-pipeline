import {
	applicationCreateSchema,
	PERSONAL_MAX_CENTS,
	PERSONAL_MIN_CENTS,
	SME_MAX_CENTS,
	SME_MIN_CENTS,
} from "@credit/core/browser";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, ErrorBox, Field, inputCls, Page } from "../components/ui";
import {
	ApiError,
	api,
	apiErrorMessage,
	createDraft,
	fetchCustomerProfile,
	formatDateOnly,
	toast,
	type CustomerProfileResponse,
} from "../lib/api";
import {
	buildApplyPayload,
	dollars,
	prefillFromProfile,
	validateApplyStep,
	type Errors,
} from "../lib/apply";
import { RequireAuth, useMe } from "../lib/auth";

export const Route = createFileRoute("/apply")({
	component: () => (
		<RequireAuth allow="applicant">
			<Wizard />
		</RequireAuth>
	),
});

function Wizard() {
	const me = useMe();
	const navigate = useNavigate();
	const [step, setStep] = useState(1);
	const [borrowerType, setBorrowerType] = useState<"individual" | "sme">("individual");
	const product = borrowerType === "individual" ? "personal_loan" : "sme_term_loan";
	const [minCents, maxCents] =
		product === "personal_loan"
			? [PERSONAL_MIN_CENTS, PERSONAL_MAX_CENTS]
			: [SME_MIN_CENTS, SME_MAX_CENTS];

	const [amount, setAmount] = useState("12000");
	const [term, setTerm] = useState("48");
	const [purpose, setPurpose] = useState("Home renovation");
	const [identity, setIdentity] = useState({
		fullName: "",
		dob: "",
		nationalId: "",
		email: me.data?.user.email ?? "",
		phone: "",
		address: "",
		city: "",
	});
	const [ind, setInd] = useState({
		employmentStatus: "employed",
		employerName: "",
		employmentYears: "5",
		monthlyIncome: "4200",
		existingDebt: "610",
		bankRelationshipYears: "3",
	});
	const [sme, setSme] = useState({
		companyName: "",
		registrationNumber: "",
		industry: "retail",
		yearsTrading: "4",
		employees: "5",
		annualRevenue: "420000",
		monthlyFcf: "2600",
		existingDebtService: "0",
	});
	const [consents, setConsents] = useState([false, false, false]);
	const [aiResearchConsent, setAiResearchConsent] = useState(false);
	const [documentProcessingConsent, setDocumentProcessingConsent] = useState(false);
	const [contextAnalysisConsent, setContextAnalysisConsent] = useState(false);
	// T17 (SPEC-t17-t18 §2.4): profiled customers get prefilled fields and
	// create a draft; legacy users without a profile keep direct create.
	const profileQuery = useQuery({
		queryKey: ["customer-profile"],
		queryFn: fetchCustomerProfile,
		retry: false,
	});
	const profile: CustomerProfileResponse | null = profileQuery.data ?? null;
	const [profileApplied, setProfileApplied] = useState(false);
	const [prefilled, setPrefilled] = useState<string[]>([]);

	// Prefill once the profile lands (same render-guard idiom as the email
	// sync below): values stay editable; edits are recorded as edited.
	if (!profileApplied && profile) {
		const p = prefillFromProfile(profile, me.data?.user.email ?? "");
		setProfileApplied(true);
		setPrefilled(p.prefilled);
		setIdentity(p.identity);
		if (p.sme) {
			setBorrowerType(p.borrowerType);
			setSme(p.sme);
		}
	}
	// ONE key per submission intent — retries reuse it (SPEC FR-1.7/1.9).
	const [idemKey] = useState(() => crypto.randomUUID());
	const [errors, setErrors] = useState<Errors>({});
	const [serverError, setServerError] = useState("");
	const [busy, setBusy] = useState(false);

	// Keep the email default in sync once the session loads.
	if (identity.email === "" && me.data?.user.email) {
		setIdentity({ ...identity, email: me.data.user.email });
	}

	const setI = (k: string, v: string) => setIdentity((p) => ({ ...p, [k]: v }));
	const setN = (k: string, v: string) => setInd((p) => ({ ...p, [k]: v }));
	const setS = (k: string, v: string) => setSme((p) => ({ ...p, [k]: v }));

	function checkStep(target: number): boolean {
		const next = validateApplyStep(target, {
			amount,
			term,
			purpose,
			identity,
			ind,
			sme,
			borrowerType,
			product,
			minCents,
			maxCents,
		});
		setErrors(next);
		return Object.keys(next).length === 0;
	}

	function payload() {
		return buildApplyPayload({
			amount,
			term,
			purpose,
			identity,
			ind,
			sme,
			borrowerType,
			product,
			minCents,
			maxCents,
			consents,
			aiResearchConsent,
			documentProcessingConsent,
			contextAnalysisConsent,
		});
	}

	async function submit() {
		if (!consents.every(Boolean)) {
			setErrors({ consents: "all 3 consents are required" });
			return;
		}
		// A profiled customer must never take the legacy direct path (the
		// server 409s it with DRAFT_REQUIRED) — wait for the lookup first.
		if (profileQuery.isPending) return;
		const body = payload();
		const parsed = applicationCreateSchema.safeParse(body);
		if (!parsed.success) {
			const flat: Errors = {};
			for (const issue of parsed.error.issues) {
				const key = issue.path.map(String).join(".") || "_";
				flat[key] = flat[key] ? `${flat[key]} ${issue.message}` : issue.message;
			}
			setErrors(flat);
			return;
		}
		setBusy(true);
		setServerError("");
		try {
			if (profile) {
				// Advisory confirmations only: the server derives reused vs
				// edited by canonical equality — a spoofed hash marks nothing
				// reused. Only fields matching the profile are claimed.
				const submitted = parsed.data;
				const profileIdentity = (profile.profile.identity ?? {}) as Record<string, unknown>;
				const profileBusiness = (profile.profile.business ?? null) as Record<
					string,
					unknown
				> | null;
				const smeForm: Record<string, unknown> = {
					companyName: sme.companyName.trim(),
					registrationNumber: sme.registrationNumber,
					industry: sme.industry,
					yearsTrading: Number(sme.yearsTrading),
					employees: Number(sme.employees),
					annualRevenueCents: dollars(sme.annualRevenue),
					monthlyFcfCents: dollars(sme.monthlyFcf),
					existingDebtServiceCents: dollars(sme.existingDebtService),
				};
				const candidates: Array<{ field: string; a: unknown; b: unknown }> = [
					...Object.keys(submitted.identity).map((k) => ({
						field: `identity.${k}`,
						a: (submitted.identity as Record<string, unknown>)[k],
						b: profileIdentity[k],
					})),
					...Object.keys(smeForm).map((k) => ({
						field: `sme.${k}`,
						a: smeForm[k],
						b: profileBusiness?.[k],
					})),
				];
				const profileConfirmations = candidates
					.filter(
						(c) =>
							c.a !== undefined &&
							c.a !== null &&
							c.a !== "" &&
							c.b !== undefined &&
							JSON.stringify(c.a) === JSON.stringify(c.b),
					)
					.map((c) => ({ field: c.field, valueHash: "web-confirmed" }));
				const res = await createDraft({ ...submitted, profileConfirmations }, idemKey);
				await navigate({ to: "/applications/$id", params: { id: res.id } });
				return;
			}
			const res = await api<{ id: string; reference: string }>("/api/applications", {
				method: "POST",
				body: parsed.data,
				headers: { "Idempotency-Key": idemKey },
			});
			await navigate({ to: "/applications/$id", params: { id: res.id } });
		} catch (err) {
			if (err instanceof ApiError && err.fields) {
				const flat: Errors = {};
				for (const [k, v] of Object.entries(err.fields)) flat[k] = v.join(" ");
				setErrors(flat);
			}
			const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : apiErrorMessage(err);
			setServerError(msg);
			toast(msg);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Page>
			<h1 className="mb-1 text-xl font-bold">New application</h1>
			<p className="mb-4 text-sm text-gray-500">Step {step} of 3</p>
			{profileQuery.isPending && (
				<p className="mb-4 text-sm text-gray-500" aria-live="polite">
					Checking your customer profile…
				</p>
			)}
			{profile && (
				<div
					className="mb-4 rounded border border-blue-200 bg-blue-50 p-3 text-sm"
					aria-live="polite"
				>
					<p className="font-medium text-blue-900">
						Prefilled from your customer profile — review, confirm, or edit every field.
					</p>
					<p className="mt-1 text-xs text-blue-800">
						KYC {profile.profile.kycStatus}
						{profile.profile.kycFresh ? "" : " (not fresh)"}
						{profile.profile.kycExpiresAt
							? ` · expires ${formatDateOnly(profile.profile.kycExpiresAt)}`
							: ""}
						{profile.accounts.length > 0
							? ` · accounts on file: ${profile.accounts.map((a) => `${a.bankName} ${a.maskedNumber}`).join("; ")}`
							: ""}
					</p>
				</div>
			)}
			{step === 1 && (
				<Card title="Loan details">
					<div className="grid gap-3 sm:grid-cols-2">
						<Field label="Borrower type">
							<select
								id="field-borrower-type"
								value={borrowerType}
								onChange={(e) => setBorrowerType(e.target.value as "individual" | "sme")}
								className={inputCls}
							>
								<option value="individual">Individual → personal loan</option>
								<option value="sme">SME → term loan</option>
							</select>
						</Field>
						<Field label="Product">
							<input
								id="field-product"
								value={product}
								disabled
								className={`${inputCls} bg-gray-100`}
							/>
						</Field>
						<Field label="Amount (USD)" error={errors.amount ?? errors.amountCents}>
							<input
								id="field-amount-usd"
								inputMode="decimal"
								value={amount}
								onChange={(e) => setAmount(e.target.value)}
								className={inputCls}
							/>
						</Field>
						<Field label="Term (months)" error={errors.term ?? errors.termMonths}>
							<input
								id="field-term-months"
								inputMode="numeric"
								value={term}
								onChange={(e) => setTerm(e.target.value)}
								className={inputCls}
							/>
						</Field>
						<div className="sm:col-span-2">
							<Field label="Purpose" error={errors.purpose}>
								<input
									id="field-purpose"
									value={purpose}
									onChange={(e) => setPurpose(e.target.value)}
									className={inputCls}
								/>
							</Field>
						</div>
					</div>
				</Card>
			)}
			{step === 2 && (
				<div className="space-y-4">
					<Card title="Identity">
						{prefilled.filter((f) => f.startsWith("identity.")).length > 0 && (
							<p className="mb-2 text-xs text-gray-500">
								From your customer profile (
								{prefilled
									.filter((f) => f.startsWith("identity."))
									.map((f) => f.slice("identity.".length))
									.join(", ")}
								) — editable; changes are recorded as edited, not reused.
							</p>
						)}
						<div className="grid gap-3 sm:grid-cols-2">
							<Field label="Full name" error={errors["identity.fullName"]}>
								<input
									id="field-full-name"
									value={identity.fullName}
									onChange={(e) => setI("fullName", e.target.value)}
									className={inputCls}
								/>
							</Field>
							<Field label="Date of birth (YYYY-MM-DD)" error={errors["identity.dob"]}>
								<input
									id="field-date-of-birth"
									placeholder="1990-05-14"
									value={identity.dob}
									onChange={(e) => setI("dob", e.target.value)}
									className={inputCls}
								/>
							</Field>
							<Field label="National ID" error={errors["identity.nationalId"]}>
								<input
									id="field-national-id"
									value={identity.nationalId}
									onChange={(e) => setI("nationalId", e.target.value)}
									className={inputCls}
								/>
							</Field>
							<Field label="Email" error={errors["identity.email"]}>
								<input
									id="field-email"
									type="email"
									value={identity.email}
									onChange={(e) => setI("email", e.target.value)}
									className={inputCls}
								/>
							</Field>
							<Field label="Phone" error={errors["identity.phone"]}>
								<input
									id="field-phone"
									value={identity.phone}
									onChange={(e) => setI("phone", e.target.value)}
									className={inputCls}
								/>
							</Field>
							<Field label="Address" error={errors["identity.address"]}>
								<input
									id="field-address"
									value={identity.address}
									onChange={(e) => setI("address", e.target.value)}
									className={inputCls}
								/>
							</Field>
							<Field label="City" error={errors["identity.city"]}>
								<input
									id="field-city"
									value={identity.city}
									onChange={(e) => setI("city", e.target.value)}
									className={inputCls}
								/>
							</Field>
						</div>
					</Card>
					{borrowerType === "individual" ? (
						<Card title="Financial (individual)">
							<div className="grid gap-3 sm:grid-cols-2">
								<Field label="Employment status">
									<select
										id="field-employment-status"
										value={ind.employmentStatus}
										onChange={(e) => setN("employmentStatus", e.target.value)}
										className={inputCls}
									>
										<option value="employed">Employed</option>
										<option value="self_employed">Self-employed</option>
										<option value="retired">Retired</option>
										<option value="student">Student</option>
									</select>
								</Field>
								<Field label="Employer name" error={errors["individual.employerName"]}>
									<input
										id="field-employer-name"
										value={ind.employerName}
										onChange={(e) => setN("employerName", e.target.value)}
										className={inputCls}
									/>
								</Field>
								<Field label="Employment years">
									<input
										id="field-employment-years"
										inputMode="numeric"
										value={ind.employmentYears}
										onChange={(e) => setN("employmentYears", e.target.value)}
										className={inputCls}
									/>
								</Field>
								<Field label="Bank relationship (years)">
									<input
										id="field-bank-relationship-years"
										inputMode="numeric"
										value={ind.bankRelationshipYears}
										onChange={(e) => setN("bankRelationshipYears", e.target.value)}
										className={inputCls}
									/>
								</Field>
								<Field label="Monthly net income (USD)" error={errors["individual.monthlyIncome"]}>
									<input
										id="field-monthly-income"
										inputMode="decimal"
										value={ind.monthlyIncome}
										onChange={(e) => setN("monthlyIncome", e.target.value)}
										className={inputCls}
									/>
								</Field>
								<Field
									label="Existing debt payments (USD/mo)"
									error={errors["individual.existingDebt"]}
								>
									<input
										id="field-existing-debt"
										inputMode="decimal"
										value={ind.existingDebt}
										onChange={(e) => setN("existingDebt", e.target.value)}
										className={inputCls}
									/>
								</Field>
							</div>
						</Card>
					) : (
						<Card title="Business (SME)">
							{prefilled.filter((f) => f.startsWith("sme.")).length > 0 && (
								<p className="mb-2 text-xs text-gray-500">
									From your customer profile (
									{prefilled
										.filter((f) => f.startsWith("sme."))
										.map((f) => f.slice("sme.".length))
										.join(", ")}
									) — editable; changes are recorded as edited, not reused.
								</p>
							)}
							<div className="grid gap-3 sm:grid-cols-2">
								<Field label="Company name" error={errors["sme.companyName"]}>
									<input
										id="field-company-name"
										value={sme.companyName}
										onChange={(e) => setS("companyName", e.target.value)}
										className={inputCls}
									/>
								</Field>
								<Field label="Registration no." error={errors["sme.registrationNumber"]}>
									<input
										id="field-registration-no"
										value={sme.registrationNumber}
										onChange={(e) => setS("registrationNumber", e.target.value)}
										className={inputCls}
									/>
								</Field>
								<Field label="Industry">
									<select
										id="field-industry"
										value={sme.industry}
										onChange={(e) => setS("industry", e.target.value)}
										className={inputCls}
									>
										<option value="hospitality">Hospitality</option>
										<option value="retail">Retail</option>
										<option value="services">Services</option>
										<option value="construction">Construction</option>
										<option value="other">Other</option>
									</select>
								</Field>
								<Field label="Years trading">
									<input
										id="field-years-trading"
										inputMode="numeric"
										value={sme.yearsTrading}
										onChange={(e) => setS("yearsTrading", e.target.value)}
										className={inputCls}
									/>
								</Field>
								<Field label="Employees">
									<input
										id="field-employees"
										inputMode="numeric"
										value={sme.employees}
										onChange={(e) => setS("employees", e.target.value)}
										className={inputCls}
									/>
								</Field>
								<Field label="Annual revenue (USD)">
									<input
										id="field-annual-revenue"
										inputMode="decimal"
										value={sme.annualRevenue}
										onChange={(e) => setS("annualRevenue", e.target.value)}
										className={inputCls}
									/>
								</Field>
								<Field label="Monthly free cash flow (USD)" error={errors["sme.monthlyFcf"]}>
									<input
										id="field-monthly-fcf"
										inputMode="decimal"
										value={sme.monthlyFcf}
										onChange={(e) => setS("monthlyFcf", e.target.value)}
										className={inputCls}
									/>
								</Field>
								<Field label="Existing debt service (USD/mo)">
									<input
										id="field-debt-service"
										inputMode="decimal"
										value={sme.existingDebtService}
										onChange={(e) => setS("existingDebtService", e.target.value)}
										className={inputCls}
									/>
								</Field>
							</div>
						</Card>
					)}
				</div>
			)}
			{step === 3 && (
				<Card title="Review & consent">
					<dl className="mb-4 grid gap-1 text-sm">
						<div className="flex justify-between">
							<dt className="text-gray-500">Type / product</dt>
							<dd className="font-medium">
								{borrowerType} / {product}
							</dd>
						</div>
						<div className="flex justify-between">
							<dt className="text-gray-500">Amount</dt>
							<dd className="font-medium">${amount}</dd>
						</div>
						<div className="flex justify-between">
							<dt className="text-gray-500">Term</dt>
							<dd className="font-medium">{term} months</dd>
						</div>
						<div className="flex justify-between">
							<dt className="text-gray-500">Name</dt>
							<dd className="font-medium">{identity.fullName || "—"}</dd>
						</div>
					</dl>
					<fieldset>
						<legend className="mb-2 text-sm font-medium">Consents (all required)</legend>
						{["Credit check consent", "Data processing consent", "Terms consent"].map(
							(label, i) => (
								<label key={label} className="flex items-center gap-2 py-1 text-sm">
									<input
										type="checkbox"
										checked={consents[i] ?? false}
										onChange={(e) =>
											setConsents((p) => p.map((c, j) => (j === i ? e.target.checked : c)))
										}
										aria-label={label}
									/>
									{label}
								</label>
							),
						)}
					</fieldset>
					<label className="mt-2 flex items-center gap-2 py-1 text-sm">
						<input
							type="checkbox"
							checked={aiResearchConsent}
							onChange={(e) => setAiResearchConsent(e.target.checked)}
							aria-label="AI research consent"
						/>
						AI research consent (optional)
					</label>
					<label className="mt-2 flex items-center gap-2 py-1 text-sm">
						<input
							type="checkbox"
							checked={documentProcessingConsent}
							onChange={(e) => setDocumentProcessingConsent(e.target.checked)}
							aria-label="Document processing consent"
						/>
						Document processing consent (optional for now)
					</label>
					<label className="mt-2 flex items-center gap-2 py-1 text-sm">
						<input
							type="checkbox"
							checked={contextAnalysisConsent}
							onChange={(e) => setContextAnalysisConsent(e.target.checked)}
							aria-label="Context analysis consent"
						/>
						Context analysis consent (optional)
					</label>
					{errors.consents && (
						<p role="alert" className="mt-1 text-sm text-red-600">
							{errors.consents}
						</p>
					)}
					{Object.entries(errors).filter(([k]) => k !== "consents").length > 0 && (
						<ul className="mt-3 space-y-1 text-sm text-red-600">
							{Object.entries(errors)
								.filter(([k]) => k !== "consents")
								.map(([k, v]) => (
									<li key={k} role="alert">
										{k}: {v}
									</li>
								))}
						</ul>
					)}
					{serverError && (
						<div className="mt-3">
							<ErrorBox message={serverError} />
						</div>
					)}
				</Card>
			)}
			<div className="mt-4 flex gap-2">
				{step > 1 && (
					<button
						type="button"
						onClick={() => setStep(step - 1)}
						className="rounded border border-gray-300 px-4 py-2 text-sm font-medium"
					>
						Back
					</button>
				)}
				{step < 3 ? (
					<button
						type="button"
						onClick={() => {
							if (checkStep(step + 1)) setStep(step + 1);
						}}
						className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white"
					>
						Continue
					</button>
				) : (
					<button
						type="button"
						onClick={submit}
						disabled={busy || profileQuery.isPending}
						className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
					>
						{busy ? "Submitting…" : profile ? "Create draft" : "Submit application"}
					</button>
				)}
			</div>
		</Page>
	);
}
