export const SCRATCH_COMPACTION_METHOD_VALUES = ["configured", "native", "standard", "both", "scratch-only"] as const;

export type ScratchCompactionMethod = (typeof SCRATCH_COMPACTION_METHOD_VALUES)[number];

export function isScratchCompactionMethod(value: string): value is ScratchCompactionMethod {
	return SCRATCH_COMPACTION_METHOD_VALUES.some(method => method === value);
}

interface ScratchCompactionOverrides {
	remoteEnabled: boolean;
	standardEnabled: boolean;
}

export function resolveScratchCompactionOverrides(
	method: ScratchCompactionMethod,
): ScratchCompactionOverrides | undefined {
	switch (method) {
		case "configured":
			return undefined;
		case "native":
			return { remoteEnabled: true, standardEnabled: false };
		case "standard":
			return { remoteEnabled: false, standardEnabled: true };
		case "both":
			return { remoteEnabled: true, standardEnabled: true };
		case "scratch-only":
			return { remoteEnabled: false, standardEnabled: false };
	}
}
