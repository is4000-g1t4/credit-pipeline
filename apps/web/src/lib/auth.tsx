// Auth state: useMe (client-side only; SSR renders shells so pages stay 200)
// + RequireAuth guard + logout. Single place every route reads the session.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { api, type MeResponse } from "./api";

const isBrowser = typeof window !== "undefined";

export function useMe() {
	return useQuery({
		queryKey: ["me"],
		queryFn: () => api<MeResponse>("/api/auth/me"),
		// SSR has no cookies — fetch only in the browser, no retries on 401.
		enabled: isBrowser,
		retry: false,
		staleTime: 30_000,
	});
}

export function useLogout() {
	const queryClient = useQueryClient();
	return async () => {
		try {
			await api("/api/auth/logout", { method: "POST" });
		} catch {
			// already logged out server-side — still clear local state
		}
		// Drop the cached session before leaving: navigating to /login while
		// the "me" query still holds a user makes the login page bounce back
		// to the role landing (caught by the Tomás E2E logout step). A hard
		// navigation guarantees no stale client state survives logout.
		queryClient.clear();
		window.location.assign("/login");
	};
}

// Prop is named `allow` (not `role`) so linters don't read it as an ARIA role.
export function RequireAuth({
	allow,
	children,
}: {
	allow?: "applicant" | "officer";
	children: ReactNode;
}) {
	const me = useMe();
	const navigate = useNavigate();
	const user = me.data?.user;

	useEffect(() => {
		if (!isBrowser || !me.isFetched) return;
		if (!me.data) void navigate({ to: "/login" });
		else if (allow && user?.role !== allow) void navigate({ to: "/" });
	}, [me.isFetched, me.data, allow, user?.role, navigate]);

	if (!me.isFetched || !me.data) {
		return (
			<main className="container-ubs py-10" aria-label="Loading">
				<div className="h-8 w-48 animate-pulse rounded-sm bg-warm" />
				<div className="mt-4 h-40 animate-pulse rounded-sm bg-warm" />
			</main>
		);
	}
	if (allow && user?.role !== allow) return null;
	return <>{children}</>;
}
