import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { Headset, Menu, Search } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { fetchFraudMe } from "../../lib/api";
import { useLogout, useMe } from "../../lib/auth";
import { ButtonLink } from "./button-link";

type NavItem = { to: string; label: string; count?: number };

const officerNav: NavItem[] = [
	{ to: "/officer", label: "Overview" },
	{ to: "/officer/review", label: "Review queue" },
	{ to: "/officer/portfolio", label: "Portfolio" },
	{ to: "/officer/policies", label: "Credit policy" },
	{ to: "/officer/fraud-review", label: "Fraud review" },
	{ to: "/loans", label: "Loans" },
];

const applicantNav: NavItem[] = [
	{ to: "/", label: "Overview" },
	{ to: "/applications", label: "Applications" },
	{ to: "/apply", label: "New application" },
	{ to: "/loans", label: "Loans" },
];

function isActive(path: string, to: string) {
	if (to === "/") return path === "/";
	if (to === "/officer") return path === "/officer" || path === "/officer/";
	if (to === "/applications") return path === "/applications" || path.startsWith("/applications/");
	if (to === "/officer/review")
		return path === "/officer/review" || path.startsWith("/officer/review/");
	if (to === "/officer/fraud-review")
		return path === "/officer/fraud-review" || path.startsWith("/officer/fraud-review/");
	return path === to || path.startsWith(`${to}/`);
}

function Logo() {
	return (
		<Link to="/" className="flex items-center gap-3" aria-label="Credit Desk home">
			<img src="/ubs-logo.svg" alt="UBS" className="h-7 w-auto" />
			<span className="h-6 w-px bg-rule-strong" aria-hidden="true" />
			<span className="text-lg leading-6 font-light text-ink">Credit Desk</span>
		</Link>
	);
}

function NavLinks({
	items,
	path,
	onNavigate,
}: {
	items: NavItem[];
	path: string;
	onNavigate?: () => void;
}) {
	return (
		<>
			{items.map((item) => (
				<Link
					key={item.to}
					to={item.to as never}
					onClick={onNavigate}
					className={cn(
						"inline-flex items-center gap-2 border-b-2 border-transparent py-1 text-base font-light text-ink transition-colors hover:border-red/40",
						isActive(path, item.to) && "border-red",
					)}
					aria-current={isActive(path, item.to) ? "page" : undefined}
				>
					{item.label}
					{item.count ? <span className="text-xs text-slate">{item.count}</span> : null}
				</Link>
			))}
		</>
	);
}

export function AppShell({ children }: { children: React.ReactNode }) {
	const me = useMe();
	const logout = useLogout();
	const path = useRouterState({ select: (s) => s.location.pathname });
	const [mobileOpen, setMobileOpen] = useState(false);
	const user = me.data?.user;
	const isOfficer = user?.role === "officer";
	const fraudMe = useQuery({
		queryKey: ["fraud-me"],
		queryFn: fetchFraudMe,
		enabled: isOfficer,
		retry: false,
		staleTime: 60_000,
	});
	const nav = isOfficer
		? officerNav.map((item) =>
				item.to === "/officer/fraud-review" && !fraudMe.data ? { ...item, count: 0 } : item,
			)
		: applicantNav;
	const visibleNav = user
		? isOfficer
			? nav.filter((item) => item.to !== "/officer/fraud-review" || fraudMe.data)
			: nav
		: [];
	const initials = (user?.fullName ?? "?")
		.split(" ")
		.map((part) => part[0])
		.slice(0, 2)
		.join("")
		.toUpperCase();

	return (
		<div className="flex min-h-screen flex-col bg-background">
			<header className="border-b border-rule bg-white">
				<div className="container-ubs flex h-16 items-center justify-between gap-4">
					<Logo />
					<div className="hidden items-center gap-5 text-xs text-slate md:flex">
						<span className="tracking-wide uppercase">EN</span>
						<span>Singapore · SGT</span>
						<button type="button" className="inline-flex items-center gap-1 hover:text-ink">
							<Headset className="size-4" strokeWidth={1.5} aria-hidden="true" />
							Support
						</button>
						{user && (
							<>
								<span className="h-5 w-px bg-rule" aria-hidden="true" />
								<span className="text-ink">{user.fullName}</span>
								<span className="flex size-8 items-center justify-center rounded-full bg-ink text-xs text-white">
									{initials}
								</span>
								<button
									type="button"
									onClick={() => void logout()}
									aria-label="Logout"
									className="hover:text-ink"
								>
									Logout
								</button>
							</>
						)}
						{user && (
							<ButtonLink
								to={isOfficer ? "/officer/review" : "/apply"}
								variant="default"
								size="sm"
								arrow={false}
							>
								{isOfficer ? "Open review" : "New application"}
							</ButtonLink>
						)}
					</div>
					<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
						<SheetTrigger asChild>
							<Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open menu">
								<Menu className="size-5" strokeWidth={1.5} />
							</Button>
						</SheetTrigger>
						<SheetContent side="right" className="w-80">
							<SheetHeader className="text-left">
								<SheetTitle>Menu</SheetTitle>
							</SheetHeader>
							<nav className="mt-4 flex flex-col gap-4" aria-label="Mobile primary">
								<NavLinks items={visibleNav} path={path} onNavigate={() => setMobileOpen(false)} />
							</nav>
							{user && (
								<div className="mt-8 border-t border-rule pt-4 text-sm text-slate">
									<p className="text-ink">{user.fullName}</p>
									<p>{isOfficer ? "Credit officer" : "Applicant"}</p>
									<button
										type="button"
										onClick={() => void logout()}
										className="mt-3 inline-flex items-center gap-1 text-red-link underline"
										aria-label="Logout"
									>
										Logout
									</button>
								</div>
							)}
						</SheetContent>
					</Sheet>
				</div>
				<div className="container-ubs hidden items-center justify-between border-t border-rule py-2 md:flex">
					<nav className="flex items-center gap-8" aria-label="Primary">
						<NavLinks items={visibleNav} path={path} />
					</nav>
					<Button variant="ghost" size="icon-sm" aria-label="Search" disabled>
						<Search className="size-5" strokeWidth={1.5} />
					</Button>
				</div>
			</header>

			<div className="flex-1">{children}</div>

			<footer className="mt-16 border-t border-rule bg-warm">
				<div className="container-ubs flex items-center justify-between border-b border-rule py-3 text-xs text-slate">
					<span>You are here: Credit Desk</span>
					<button
						type="button"
						onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
						className="hover:text-ink"
					>
						Back to top
					</button>
				</div>
				<div className="container-ubs grid gap-8 py-10 sm:grid-cols-2 lg:grid-cols-4">
					<FooterColumn
						title="Credit desk"
						links={[
							["Overview", isOfficer ? "/officer" : "/"],
							["Review queue", "/officer/review"],
							["Portfolio", "/officer/portfolio"],
							["Credit policy", "/officer/policies"],
						]}
						officerOnly
						isOfficer={Boolean(isOfficer)}
					/>
					{!isOfficer && (
						<FooterColumn
							title="For clients"
							links={[
								["Applications", "/applications"],
								["New application", "/apply"],
								["Loans", "/loans"],
							]}
						/>
					)}
					<FooterColumn
						title="Support"
						links={[
							["Help centre", "https://www.ubs.com/global/en/contact.html"],
							["Contact UBS", "https://www.ubs.com/global/en/contact.html"],
							["Security", "https://www.ubs.com/global/en/our-firm/cybersafe.html"],
						]}
						external
					/>
					<FooterColumn
						title="About"
						links={[
							["UBS.com", "https://www.ubs.com/global/en.html"],
							["Our firm", "https://www.ubs.com/global/en/our-firm.html"],
							["Legal & privacy", "https://www.ubs.com/global/en/legal/privacy.html"],
						]}
						external
					/>
				</div>
				<div className="container-ubs border-t border-rule py-5 text-xs leading-5 text-slate">
					<p>
						Demonstration environment. Not for client use. All applications, balances and AI answers
						are deterministic mock data. UBS marks and typefaces are used for the UBS-facing concept
						only.
					</p>
					<p className="mt-2">© UBS 1998–2026. All rights reserved.</p>
				</div>
			</footer>
		</div>
	);
}

function FooterColumn({
	title,
	links,
	external = false,
	officerOnly = false,
	isOfficer = false,
}: {
	title: string;
	links: Array<[string, string]>;
	external?: boolean;
	officerOnly?: boolean;
	isOfficer?: boolean;
}) {
	if (officerOnly && !isOfficer) return null;
	return (
		<div>
			<h3 className="mb-3 text-sm font-medium text-ink">{title}</h3>
			<ul className="space-y-2 text-sm text-slate">
				{links.map(([label, href]) => (
					<li key={label}>
						{external ? (
							<a href={href} target="_blank" rel="noreferrer" className="hover:text-ink">
								{label}
							</a>
						) : (
							<Link to={href as never} className="hover:text-ink">
								{label}
							</Link>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
