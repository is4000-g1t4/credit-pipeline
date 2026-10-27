import type { ReactNode } from "react";
import { cn } from "cn";

/** UBS page frame: 1290px content inside 40px gutters (24/20 on tablet/mobile). */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
	return <main className={cn("container-ubs py-8 md:py-12", className)}>{children}</main>;
}
