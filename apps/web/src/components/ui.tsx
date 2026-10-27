// UBS Credit Desk shared primitives. Pages import from here; shadcn
// components live in ./ui and are composed by these wrappers.
import type { ReactNode } from "react";
import { Panel } from "./ubs/panel";

export {
	AreaChart,
	BarRow,
	ButtonLink,
	CodeTag,
	EmptyState,
	ErrorBox,
	Field,
	inputCls,
	Kpi,
	MockBadge,
	MockTag,
	Money,
	Overline,
	Page,
	PageHead,
	Panel,
	SectionHead,
	Skeleton,
	StatusBadge,
	Tag,
	Toaster,
} from "./ubs";

/** Legacy panel API kept for existing routes during the redesign. */
export function Card({
	title,
	actions,
	children,
	className,
}: {
	title?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<Panel title={title} action={actions} outline className={className}>
			{children}
		</Panel>
	);
}
