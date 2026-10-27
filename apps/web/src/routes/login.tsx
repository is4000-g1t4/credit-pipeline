import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, api, apiErrorMessage, DEMO_ACCOUNTS, DEMO_PASSWORD } from "../lib/api";
import { useMe } from "../lib/auth";
import { ErrorBox, Overline, Page, PageHead, Panel } from "../components/ubs";

export const Route = createFileRoute("/login")({
	component: Login,
});

function Login() {
	const me = useMe();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState(DEMO_PASSWORD);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	// Redirect already-authenticated users by role.
	useEffect(() => {
		if (me.data) void navigate({ to: "/" });
	}, [me.data, navigate]);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError("");
		try {
			await api("/api/auth/login", {
				method: "POST",
				body: { email: email.trim(), password },
			});
			await queryClient.invalidateQueries({ queryKey: ["me"] });
			await navigate({ to: "/" });
		} catch (err) {
			const msg = apiErrorMessage(err);
			setError(err instanceof ApiError && err.status === 401 ? "Invalid email or password." : msg);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Page>
			<PageHead
				title="Sign in to Credit Desk"
				subtitle="Use your demo account. No real client data is stored in this environment."
			/>
			<div className="grid gap-8 lg:grid-cols-5">
				<Panel tone="ink" className="lg:col-span-3">
					<Overline className="text-white">UBS Credit Desk</Overline>
					<h2 className="mt-4 text-4xl leading-tight font-light text-white">
						Banking is our craft.
					</h2>
					<span className="mt-4 block h-1 w-16 bg-red" aria-hidden="true" />
					<p className="mt-4 max-w-md text-lg leading-7 font-light text-white">
						A quieter, evidence-led credit workflow — every application cited, every decision human.
					</p>
					<dl className="mt-8 grid gap-6 sm:grid-cols-3">
						<div>
							<Overline className="text-white">Apply</Overline>
							<p className="mt-2 text-sm leading-5 text-white">
								One wizard, three steps, no surprises.
							</p>
						</div>
						<div>
							<Overline className="text-white">Track</Overline>
							<p className="mt-2 text-sm leading-5 text-white">
								Verification, decision and funds — in one place.
							</p>
						</div>
						<div>
							<Overline className="text-white">Repay</Overline>
							<p className="mt-2 text-sm leading-5 text-white">
								Schedule, balance and alerts on your loan.
							</p>
						</div>
					</dl>
				</Panel>
				<div className="space-y-4 lg:col-span-2">
					<Panel title="Sign in" outline>
						<form onSubmit={submit} className="grid gap-4">
							<div className="space-y-2">
								<Label htmlFor="field-email">Email</Label>
								<Input
									id="field-email"
									type="email"
									autoComplete="email"
									required
									value={email}
									onChange={(e) => setEmail(e.target.value)}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="field-password">Password</Label>
								<Input
									id="field-password"
									type="password"
									autoComplete="current-password"
									required
									value={password}
									onChange={(e) => setPassword(e.target.value)}
								/>
							</div>
							{error && <ErrorBox message={error} />}
							<Button type="submit" disabled={busy} className="w-full">
								{busy ? "Signing in…" : "Sign in"}
							</Button>
						</form>
					</Panel>
					<Panel title={`Demo accounts (password: ${DEMO_PASSWORD})`} tone="warm">
						<ul className="grid gap-2">
							{DEMO_ACCOUNTS.map((a) => (
								<li key={a.email}>
									<button
										type="button"
										onClick={() => setEmail(a.email)}
										className="w-full rounded-sm border border-rule-strong bg-card px-4 py-2.5 text-left hover:bg-raised"
										aria-label={`Use demo account ${a.email}`}
									>
										<span className="block text-sm tabular text-ink">{a.email}</span>
										<span className="mt-0.5 block text-xs text-slate">{a.label}</span>
									</button>
								</li>
							))}
						</ul>
					</Panel>
				</div>
			</div>
		</Page>
	);
}
