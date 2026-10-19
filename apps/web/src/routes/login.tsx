import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, ErrorBox, Field, inputCls, Page } from "../components/ui";
import { ApiError, api, apiErrorMessage, DEMO_ACCOUNTS, DEMO_PASSWORD } from "../lib/api";
import { useMe } from "../lib/auth";

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
			<div className="mx-auto max-w-md">
				<Card title="Login">
					<form onSubmit={submit} className="grid gap-3">
						<Field label="Email">
							<input
								id="field-email"
								type="email"
								autoComplete="email"
								required
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								className={inputCls}
							/>
						</Field>
						<Field label="Password">
							<input
								id="field-password"
								type="password"
								autoComplete="current-password"
								required
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								className={inputCls}
							/>
						</Field>
						{error && <ErrorBox message={error} />}
						<button
							type="submit"
							disabled={busy}
							className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
						>
							{busy ? "Signing in…" : "Sign in"}
						</button>
					</form>
				</Card>
				<div className="mt-4">
					<Card title={`Demo accounts (password: ${DEMO_PASSWORD})`}>
						<ul className="grid gap-1.5">
							{DEMO_ACCOUNTS.map((a) => (
								<li key={a.email}>
									<button
										type="button"
										onClick={() => setEmail(a.email)}
										className="w-full rounded border border-gray-200 px-3 py-1.5 text-left text-sm hover:bg-gray-50"
										aria-label={`Fill login as ${a.label}`}
									>
										<span className="font-mono text-xs">{a.email}</span>
										<span className="ml-2 text-gray-500">{a.label}</span>
									</button>
								</li>
							))}
						</ul>
					</Card>
				</div>
			</div>
		</Page>
	);
}
