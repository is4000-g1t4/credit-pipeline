import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "../components/ubs/app-shell";
import { Toaster } from "../components/ubs/states";
import "../styles/app.css";

export const Route = createRootRoute({
	component: RootDocument,
});

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
				<title>UBS Credit Desk</title>
				<HeadContent />
			</head>
			<body>
				<QueryClientProvider client={queryClient}>
					<AppShell>
						<Outlet />
					</AppShell>
					<Toaster />
				</QueryClientProvider>
				<Scripts />
			</body>
		</html>
	);
}
