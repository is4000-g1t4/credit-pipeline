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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Steps } from "../components/applicant/steps";
import { ErrorBox, Money, Overline, Page, PageHead, Panel, inputCls } from "../components/ubs";
import {
	ApiError,
	api,
	apiErrorMessage,
	createDraft,
	fetchCustomerProfile,
	formatDateOnly,
	formatMoney,
	productLabel,
	toast,
	typeLabel,
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

const STEP_TITLES = ["Loan details", "About you", "Review & consent"];
const STEP_SUBTITLES = [
	"Tell us what you need and for how long. You can change everything before you submit.",
	"We use this to verify your identity. It is encrypted and never shared with other clients.",
	"Review the details, choose your consents, and submit. Nothing is sent before this step.",
];

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

	const amountCents = dollars(amount) ?? 0;

	return (
		<Page>
			<PageHead title={STEP_TITLES[step - 1]} subtitle={STEP_SUBTITLES[step - 1]} />
			<div className="mb-8">
				<Steps steps={STEP_TITLES} current={step - 1} />
			</div>
			{profileQuery.isPending && (
				<p className="mb-4 text-sm text-slate" aria-live="polite">
					Checking your customer profile…
				</p>
			)}
			{profile && (
				<div className="mb-6 rounded-sm bg-warm p-4 text-sm" aria-live="polite">
					<p className="font-medium text-ink">
						Prefilled from your customer profile — review, confirm, or edit every field.
					</p>
					<p className="mt-1 text-xs text-slate">
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
			<div className="grid gap-8 lg:grid-cols-3">
				<div className="space-y-4 lg:col-span-2">
					{step === 1 && (
						<Panel title="Loan details" outline>
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="space-y-2">
									<Label htmlFor="field-borrower-type">Borrower type</Label>
									<select
										id="field-borrower-type"
										value={borrowerType}
										onChange={(e) => setBorrowerType(e.target.value as "individual" | "sme")}
										className={inputCls}
									>
										<option value="individual">Individual → personal loan</option>
										<option value="sme">SME → term loan</option>
									</select>
								</div>
								<div className="space-y-2">
									<span className="text-xs font-medium text-slate">Product</span>
									<p
										id="field-product"
										className="flex h-12 items-center border-b border-rule-strong text-base text-ink"
									>
										{productLabel(product)}
									</p>
								</div>
								<div className="space-y-2">
									<Label htmlFor="field-amount-usd">Amount (USD)</Label>
									<Input
										id="field-amount-usd"
										inputMode="decimal"
										value={amount}
										onChange={(e) => setAmount(e.target.value)}
									/>
									{(errors.amount ?? errors.amountCents) && (
										<p role="alert" className="text-xs text-danger-ink">
											{errors.amount ?? errors.amountCents}
										</p>
									)}
								</div>
								<div className="space-y-2">
									<Label htmlFor="field-term-months">Term (months)</Label>
									<Input
										id="field-term-months"
										inputMode="numeric"
										value={term}
										onChange={(e) => setTerm(e.target.value)}
									/>
									{(errors.term ?? errors.termMonths) && (
										<p role="alert" className="text-xs text-danger-ink">
											{errors.term ?? errors.termMonths}
										</p>
									)}
								</div>
								<div className="space-y-2 sm:col-span-2">
									<Label htmlFor="field-purpose">Purpose</Label>
									<Input
										id="field-purpose"
										value={purpose}
										onChange={(e) => setPurpose(e.target.value)}
									/>
									{errors.purpose && (
										<p role="alert" className="text-xs text-danger-ink">
											{errors.purpose}
										</p>
									)}
								</div>
							</div>
						</Panel>
					)}
					{step === 2 && (
						<div className="space-y-4">
							<Panel title="Identity" outline>
								{prefilled.filter((f) => f.startsWith("identity.")).length > 0 && (
									<p className="mb-4 text-xs text-slate">
										From your customer profile (
										{prefilled
											.filter((f) => f.startsWith("identity."))
											.map((f) => f.slice("identity.".length))
											.join(", ")}{" "}
										) — editable; changes are recorded as edited, not reused.
									</p>
								)}
								<div className="grid gap-4 sm:grid-cols-2">
									<div className="space-y-2">
										<Label htmlFor="field-full-name">Full name</Label>
										<Input
											id="field-full-name"
											value={identity.fullName}
											onChange={(e) => setI("fullName", e.target.value)}
										/>
										{errors["identity.fullName"] && (
											<p role="alert" className="text-xs text-danger-ink">
												{errors["identity.fullName"]}
											</p>
										)}
									</div>
									<div className="space-y-2">
										<Label htmlFor="field-date-of-birth">Date of birth (YYYY-MM-DD)</Label>
										<Input
											id="field-date-of-birth"
											placeholder="1990-05-14"
											value={identity.dob}
											onChange={(e) => setI("dob", e.target.value)}
										/>
										{errors["identity.dob"] && (
											<p role="alert" className="text-xs text-danger-ink">
												{errors["identity.dob"]}
											</p>
										)}
									</div>
									<div className="space-y-2">
										<Label htmlFor="field-national-id">National ID</Label>
										<Input
											id="field-national-id"
											value={identity.nationalId}
											onChange={(e) => setI("nationalId", e.target.value)}
										/>
										{errors["identity.nationalId"] && (
											<p role="alert" className="text-xs text-danger-ink">
												{errors["identity.nationalId"]}
											</p>
										)}
									</div>
									<div className="space-y-2">
										<Label htmlFor="field-email">Email</Label>
										<Input
											id="field-email"
											type="email"
											value={identity.email}
											onChange={(e) => setI("email", e.target.value)}
										/>
										{errors["identity.email"] && (
											<p role="alert" className="text-xs text-danger-ink">
												{errors["identity.email"]}
											</p>
										)}
									</div>
									<div className="space-y-2">
										<Label htmlFor="field-phone">Phone</Label>
										<Input
											id="field-phone"
											value={identity.phone}
											onChange={(e) => setI("phone", e.target.value)}
										/>
										{errors["identity.phone"] && (
											<p role="alert" className="text-xs text-danger-ink">
												{errors["identity.phone"]}
											</p>
										)}
									</div>
									<div className="space-y-2">
										<Label htmlFor="field-address">Address</Label>
										<Input
											id="field-address"
											value={identity.address}
											onChange={(e) => setI("address", e.target.value)}
										/>
										{errors["identity.address"] && (
											<p role="alert" className="text-xs text-danger-ink">
												{errors["identity.address"]}
											</p>
										)}
									</div>
									<div className="space-y-2 sm:col-span-2">
										<Label htmlFor="field-city">City</Label>
										<Input
											id="field-city"
											value={identity.city}
											onChange={(e) => setI("city", e.target.value)}
										/>
										{errors["identity.city"] && (
											<p role="alert" className="text-xs text-danger-ink">
												{errors["identity.city"]}
											</p>
										)}
									</div>
								</div>
							</Panel>
							{borrowerType === "individual" ? (
								<Panel title="Financial (individual)" outline>
									<div className="grid gap-4 sm:grid-cols-2">
										<div className="space-y-2">
											<Label htmlFor="field-employment-status">Employment status</Label>
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
										</div>
										<div className="space-y-2">
											<Label htmlFor="field-employer-name">Employer name</Label>
											<Input
												id="field-employer-name"
												value={ind.employerName}
												onChange={(e) => setN("employerName", e.target.value)}
											/>
											{errors["individual.employerName"] && (
												<p role="alert" className="text-xs text-danger-ink">
													{errors["individual.employerName"]}
												</p>
											)}
										</div>
										<div className="space-y-2">
											<Label htmlFor="field-employment-years">Employment years</Label>
											<Input
												id="field-employment-years"
												inputMode="numeric"
												value={ind.employmentYears}
												onChange={(e) => setN("employmentYears", e.target.value)}
											/>
										</div>
										<div className="space-y-2">
											<Label htmlFor="field-bank-relationship-years">
												Bank relationship (years)
											</Label>
											<Input
												id="field-bank-relationship-years"
												inputMode="numeric"
												value={ind.bankRelationshipYears}
												onChange={(e) => setN("bankRelationshipYears", e.target.value)}
											/>
										</div>
										<div className="space-y-2">
											<Label htmlFor="field-monthly-income">Monthly net income (USD)</Label>
											<Input
												id="field-monthly-income"
												inputMode="decimal"
												value={ind.monthlyIncome}
												onChange={(e) => setN("monthlyIncome", e.target.value)}
											/>
											{errors["individual.monthlyIncome"] && (
												<p role="alert" className="text-xs text-danger-ink">
													{errors["individual.monthlyIncome"]}
												</p>
											)}
										</div>
										<div className="space-y-2">
											<Label htmlFor="field-existing-debt">Existing debt payments (USD/mo)</Label>
											<Input
												id="field-existing-debt"
												inputMode="decimal"
												value={ind.existingDebt}
												onChange={(e) => setN("existingDebt", e.target.value)}
											/>
											{errors["individual.existingDebt"] && (
												<p role="alert" className="text-xs text-danger-ink">
													{errors["individual.existingDebt"]}
												</p>
											)}
										</div>
									</div>
								</Panel>
							) : (
								<Panel title="Business (SME)" outline>
									{prefilled.filter((f) => f.startsWith("sme.")).length > 0 && (
										<p className="mb-4 text-xs text-slate">
											From your customer profile (
											{prefilled
												.filter((f) => f.startsWith("sme."))
												.map((f) => f.slice("sme.".length))
												.join(", ")}{" "}
											) — editable; changes are recorded as edited, not reused.
										</p>
									)}
									<div className="grid gap-4 sm:grid-cols-2">
										<div className="space-y-2">
											<Label htmlFor="field-company-name">Company name</Label>
											<Input
												id="field-company-name"
												value={sme.companyName}
												onChange={(e) => setS("companyName", e.target.value)}
											/>
											{errors["sme.companyName"] && (
												<p role="alert" className="text-xs text-danger-ink">
													{errors["sme.companyName"]}
												</p>
											)}
										</div>
										<div className="space-y-2">
											<Label htmlFor="field-registration-no">Registration no.</Label>
											<Input
												id="field-registration-no"
												value={sme.registrationNumber}
												onChange={(e) => setS("registrationNumber", e.target.value)}
											/>
											{errors["sme.registrationNumber"] && (
												<p role="alert" className="text-xs text-danger-ink">
													{errors["sme.registrationNumber"]}
												</p>
											)}
										</div>
										<div className="space-y-2">
											<Label htmlFor="field-industry">Industry</Label>
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
										</div>
										<div className="space-y-2">
											<Label htmlFor="field-years-trading">Years trading</Label>
											<Input
												id="field-years-trading"
												inputMode="numeric"
												value={sme.yearsTrading}
												onChange={(e) => setS("yearsTrading", e.target.value)}
											/>
										</div>
										<div className="space-y-2">
											<Label htmlFor="field-employees">Employees</Label>
											<Input
												id="field-employees"
												inputMode="numeric"
												value={sme.employees}
												onChange={(e) => setS("employees", e.target.value)}
											/>
										</div>
										<div className="space-y-2">
											<Label htmlFor="field-annual-revenue">Annual revenue (USD)</Label>
											<Input
												id="field-annual-revenue"
												inputMode="decimal"
												value={sme.annualRevenue}
												onChange={(e) => setS("annualRevenue", e.target.value)}
											/>
										</div>
										<div className="space-y-2">
											<Label htmlFor="field-monthly-fcf">Monthly free cash flow (USD)</Label>
											<Input
												id="field-monthly-fcf"
												inputMode="decimal"
												value={sme.monthlyFcf}
												onChange={(e) => setS("monthlyFcf", e.target.value)}
											/>
											{errors["sme.monthlyFcf"] && (
												<p role="alert" className="text-xs text-danger-ink">
													{errors["sme.monthlyFcf"]}
												</p>
											)}
										</div>
										<div className="space-y-2">
											<Label htmlFor="field-debt-service">Existing debt service (USD/mo)</Label>
											<Input
												id="field-debt-service"
												inputMode="decimal"
												value={sme.existingDebtService}
												onChange={(e) => setS("existingDebtService", e.target.value)}
											/>
										</div>
									</div>
								</Panel>
							)}
						</div>
					)}
					{step === 3 && (
						<Panel title="Review & consent" outline>
							<dl className="mb-6 grid gap-1 border-b border-rule pb-6 text-sm">
								<div className="flex justify-between gap-4">
									<dt className="text-slate">Type / product</dt>
									<dd className="font-medium text-ink">
										{typeLabel(borrowerType)} / {productLabel(product)}
									</dd>
								</div>
								<div className="flex justify-between gap-4">
									<dt className="text-slate">Amount</dt>
									<dd className="font-medium tabular text-ink">
										{amountCents > 0 ? formatMoney(amountCents) : "$" + amount}
									</dd>
								</div>
								<div className="flex justify-between gap-4">
									<dt className="text-slate">Term</dt>
									<dd className="font-medium text-ink">{term} months</dd>
								</div>
								<div className="flex justify-between gap-4">
									<dt className="text-slate">Name</dt>
									<dd className="font-medium text-ink">{identity.fullName || "—"}</dd>
								</div>
							</dl>
							<fieldset>
								<legend className="mb-2 text-sm font-medium text-ink">
									Consents (all required)
								</legend>
								{["Credit check consent", "Data processing consent", "Terms consent"].map(
									(label, i) => (
										<label key={label} className="flex items-center gap-2 py-1 text-sm text-ink">
											<input
												type="checkbox"
												className="size-4"
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
							<label className="mt-2 flex items-center gap-2 py-1 text-sm text-ink">
								<input
									type="checkbox"
									className="size-4"
									checked={aiResearchConsent}
									onChange={(e) => setAiResearchConsent(e.target.checked)}
									aria-label="AI research consent"
								/>
								AI research consent (optional)
							</label>
							<label className="mt-2 flex items-center gap-2 py-1 text-sm text-ink">
								<input
									type="checkbox"
									className="size-4"
									checked={documentProcessingConsent}
									onChange={(e) => setDocumentProcessingConsent(e.target.checked)}
									aria-label="Document processing consent"
								/>
								Document processing consent (optional for now)
							</label>
							<label className="mt-2 flex items-center gap-2 py-1 text-sm text-ink">
								<input
									type="checkbox"
									className="size-4"
									checked={contextAnalysisConsent}
									onChange={(e) => setContextAnalysisConsent(e.target.checked)}
									aria-label="Context analysis consent"
								/>
								Context analysis consent (optional)
							</label>
							{errors.consents && (
								<p role="alert" className="mt-1 text-sm text-danger-ink">
									{errors.consents}
								</p>
							)}
							{Object.entries(errors).filter(([k]) => k !== "consents").length > 0 && (
								<ul className="mt-3 space-y-1 text-sm text-danger-ink">
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
						</Panel>
					)}
					<div className="flex flex-wrap gap-3">
						{step > 1 && (
							<Button type="button" variant="outline" onClick={() => setStep(step - 1)}>
								Back
							</Button>
						)}
						{step < 3 ? (
							<Button
								type="button"
								onClick={() => {
									if (checkStep(step + 1)) setStep(step + 1);
								}}
							>
								Continue
							</Button>
						) : (
							<Button type="button" onClick={submit} disabled={busy || profileQuery.isPending}>
								{busy ? "Submitting…" : profile ? "Create draft" : "Submit application"}
							</Button>
						)}
					</div>
				</div>
				<aside>
					<Panel title="Your application" tone="warm">
						<Overline>{productLabel(product)}</Overline>
						<p className="mt-2 text-4xl leading-tight font-light tabular text-ink">
							<Money cents={amountCents} />
						</p>
						<p className="mt-1 text-sm text-slate">over {term} months</p>
						<dl className="mt-4 space-y-1 border-t border-rule pt-4 text-sm">
							<div className="flex justify-between gap-4">
								<dt className="text-slate">Borrowing range</dt>
								<dd className="font-medium tabular text-ink">
									{formatMoney(minCents)} – {formatMoney(maxCents)}
								</dd>
							</div>
							<div className="flex justify-between gap-4">
								<dt className="text-slate">Purpose</dt>
								<dd className="font-medium text-ink">{purpose || "—"}</dd>
							</div>
						</dl>
						<p className="mt-4 text-xs text-slate">
							Indicative only. Final rate and terms are confirmed at the decision.
						</p>
					</Panel>
				</aside>
			</div>
		</Page>
	);
}
