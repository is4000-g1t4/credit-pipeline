import { cn } from "cn";

export function AreaChart({
	values,
	labels,
	height = 150,
	accent = "var(--red)",
	unit,
}: {
	values: number[];
	labels?: string[];
	height?: number;
	accent?: string;
	unit?: string;
}) {
	const width = 640;
	const pad = 8;
	const max = Math.max(...values) * 1.12;
	const min = Math.min(...values) * 0.82;
	const span = max - min || 1;
	const x = (i: number) => pad + (i * (width - pad * 2)) / Math.max(values.length - 1, 1);
	const y = (v: number) => pad + ((max - v) / span) * (height - pad * 2);
	const line = values
		.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
		.join(" ");
	const area = `${line} L${x(values.length - 1).toFixed(1)},${height - pad} L${pad},${height - pad} Z`;
	return (
		<figure>
			<div className="relative" style={{ height }}>
				<svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="Trend chart">
					<title>Trend chart</title>
					{[0.25, 0.5, 0.75, 1].map((g) => (
						<line
							key={g}
							x1={0}
							x2={width}
							y1={height * g}
							y2={height * g}
							stroke="var(--rule)"
							strokeWidth="1"
						/>
					))}
					<path d={area} className="fill-primary/5" />
					<path
						d={line}
						fill="none"
						stroke={accent}
						strokeWidth="2"
						vectorEffect="non-scaling-stroke"
					/>
					<circle
						cx={x(values.length - 1)}
						cy={y(values[values.length - 1] ?? 0)}
						r="3.5"
						fill={accent}
					/>
				</svg>
			</div>
			{labels && (
				<figcaption className="mt-2 flex justify-between text-xs text-slate">
					{labels.map((label) => (
						<span key={label}>{label}</span>
					))}
				</figcaption>
			)}
			{unit && <figcaption className="mt-1 text-xs text-slate">{unit}</figcaption>}
		</figure>
	);
}

export function BarRow({
	label,
	value,
	pct,
	color,
}: {
	label: string;
	value: string;
	pct: number;
	color: string;
}) {
	return (
		<div>
			<div className="mb-1 flex items-center justify-between gap-3 text-sm">
				<span className="text-ink">{label}</span>
				<span className="tabular text-slate">{value}</span>
			</div>
			<span className="block h-1 w-full bg-warm">
				<span
					className={cn("block h-1")}
					style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }}
				/>
			</span>
		</div>
	);
}
