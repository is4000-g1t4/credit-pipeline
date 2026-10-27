// Demo-mode constants (login page + demo gates).

export const DEMO_PASSWORD = "demo1234";
export const DEMO_ACCOUNTS: Array<{ email: string; label: string }> = [
	{ email: "maria@example.com", label: "Maria (auto-approve)" },
	{ email: "alex@example.com", label: "Alex (refer)" },
	{ email: "sam@example.com", label: "Sam (decline)" },
	{ email: "tomas@cafe-aurora.example", label: "Tomás SME (refer)" },
	{ email: "lena@bakery.example", label: "Lena SME (auto)" },
	{ email: "officer@example.com", label: "Officer" },
];
