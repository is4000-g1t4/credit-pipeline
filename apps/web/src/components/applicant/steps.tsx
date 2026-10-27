// Local stepper for the applicant apply wizard (visual only; the wizard
// owns the step state and validation in routes/apply.tsx).
export function Steps({ steps, current }: { steps: string[]; current: number }) {
	return (
		<ol className="flex flex-wrap items-center gap-x-2 gap-y-3" aria-label="Application progress">
			{steps.map((step, i) => {
				const done = i < current;
				const active = i === current;
				return (
					<li key={step} className="flex items-center gap-2">
						<span
							className={
								done
									? "flex size-8 items-center justify-center rounded-sm bg-ink text-xs font-medium text-white"
									: active
										? "flex size-8 items-center justify-center rounded-sm bg-red text-xs font-medium text-white"
										: "flex size-8 items-center justify-center rounded-sm bg-warm text-xs font-medium text-slate"
							}
							aria-hidden="true"
						>
							{done ? "✓" : String(i + 1).padStart(2, "0")}
						</span>
						<span
							className={active ? "text-sm font-medium text-ink" : "text-sm text-slate"}
							aria-current={active ? "step" : undefined}
						>
							{step}
						</span>
						{i < steps.length - 1 && <span className="mx-2 h-px w-6 bg-rule" aria-hidden="true" />}
					</li>
				);
			})}
		</ol>
	);
}
