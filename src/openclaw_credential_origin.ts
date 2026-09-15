// Capture the host configuration before workflow/step environment overrides.
// This is transport credential routing, not a sandbox for executable workflows.
export function configuredOpenClawOrigin(env: Record<string, string | undefined>): string | null {
	const value = env.OPENCLAW_URL ?? env.CLAWD_URL;
	if (!value?.trim()) return null;
	try {
		const url = new URL(value.trim());
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
		return url.origin;
	} catch {
		return null;
	}
}
