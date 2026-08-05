import goControlFlow from "./aperture-go-control-flow.md" with { type: "text" };
import goErrorShape from "./aperture-go-error-shape.md" with { type: "text" };
import goForbiddenPackages from "./aperture-go-forbidden-packages.md" with { type: "text" };
import goStructContract from "./aperture-go-struct-contract.md" with { type: "text" };
import goTests from "./aperture-go-tests.md" with { type: "text" };
import tsAsyncLifecycle from "./aperture-ts-async-lifecycle.md" with { type: "text" };
import tsCn from "./aperture-ts-cn.md" with { type: "text" };
import tsDoctor from "./aperture-ts-doctor.md" with { type: "text" };
import tsFileContract from "./aperture-ts-file-contract.md" with { type: "text" };

export interface ApertureRuleSource {
	name: string;
	content: string;
}

export const APERTURE_RULE_SOURCES: readonly ApertureRuleSource[] = [
	{ name: "aperture-go-control-flow", content: goControlFlow },
	{ name: "aperture-go-error-shape", content: goErrorShape },
	{ name: "aperture-go-forbidden-packages", content: goForbiddenPackages },
	{ name: "aperture-go-struct-contract", content: goStructContract },
	{ name: "aperture-go-tests", content: goTests },
	{ name: "aperture-ts-async-lifecycle", content: tsAsyncLifecycle },
	{ name: "aperture-ts-cn", content: tsCn },
	{ name: "aperture-ts-doctor", content: tsDoctor },
	{ name: "aperture-ts-file-contract", content: tsFileContract },
];
