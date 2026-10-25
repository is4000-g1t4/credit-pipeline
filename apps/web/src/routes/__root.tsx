import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Toaster } from "../components/ui";
import { fetchFraudMe } from "../lib/api";
import { useLogout, useMe } from "../lib/auth";
import "../styles/app.css";

export const Route = createRootRoute({
	component: RootDocument,
});

function Header() {
	const me = useMe();
	const logout = useLogout();
	const user = me.data?.user;
	// Reviewer/queue visibility is server-computed; a null (404/flag-off)
	// response simply hides the link. Never blocks existing nav.
	const fraudMe = useQuery({
		queryKey: ["fraud-me"],
		queryFn: fetchFraudMe,
		enabled: user?.role === "officer",
		retry: false,
		staleTime: 60_000,
	});
	return (
		<header className="border-b border-gray-200 bg-white">
			<div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 p-4">
				<Link to="/" className="text-base font-bold">
					Credit pipeline
				</Link>
				<nav aria-label="Primary" className="flex flex-wrap items-center gap-3 text-sm">
					{user ? (
						<>
							{user.role === "officer" ? (
								<>
									<Link to="/officer" className="text-blue-700 hover:underline">
										Dashboard
									</Link>
									<Link to="/officer/review" className="text-blue-700 hover:underline">
										Review queue
									</Link>
									<Link to="/officer/policies" className="text-blue-700 hover:underline">
										Credit policy
									</Link>
									{fraudMe.data ? (
										<Link to="/officer/fraud-review" className="text-blue-700 hover:underline">
											Fraud review
										</Link>
									) : null}
									<Link to="/loans" className="text-blue-700 hover:underline">
										Loans
									</Link>
								</>
							) : (
								<>
									<Link to="/apply" className="text-blue-700 hover:underline">
										New application
									</Link>
									<Link to="/applications" className="text-blue-700 hover:underline">
										Applications
									</Link>
									<Link to="/loans" className="text-blue-700 hover:underline">
										Loans
									</Link>
								</>
							)}
							<span className="text-gray-500">
								{user.fullName} ({user.role})
							</span>
							<button
								type="button"
								onClick={() => void logout()}
								className="rounded border border-gray-300 px-2 py-1 text-sm"
							>
								Logout
							</button>
						</>
					) : (
						<Link to="/login" className="text-blue-700 hover:underline">
							Login
						</Link>
					)}
				</nav>
			</div>
		</header>
	);
}

function RootDocument() {
	const [queryClient] = useState(() => new QueryClient());
	// E2E/UX marker: interactions are inert until React hydrates the SSR
	// markup. Set this only after hydration so tests can wait deterministically
	// instead of guessing with timeouts (see e2e/helpers.ts gotoHydrated).
	useEffect(() => {
		document.documentElement.dataset.hydrated = "true";
	}, []);
	return (
		<html lang="en">
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>Credit pipeline</title>
				<HeadContent />
			</head>
			<body className="bg-gray-50 text-gray-900">
				<QueryClientProvider client={queryClient}>
					<Header />
					<Outlet />
					<Toaster />
				</QueryClientProvider>
				<Scripts />
			</body>
		</html>
	);
}
