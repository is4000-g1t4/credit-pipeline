// Pricing (SPEC FR-8.1): rateBps = 650 + gradeSpread + productMargin, cap 2400.
import {
	BASE_RATE_BPS,
	GRADE_SPREAD_BPS,
	type Grade,
	MAX_RATE_BPS,
	PRODUCT_MARGIN_BPS,
	type Product,
} from "./constants.js";

export function rateBps(grade: Grade, product: Product): number {
	return Math.min(
		MAX_RATE_BPS,
		BASE_RATE_BPS + GRADE_SPREAD_BPS[grade] + PRODUCT_MARGIN_BPS[product],
	);
}
