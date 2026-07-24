const MAINTAINER_DOC_PATHS: Record<string, true> = {
	"ERRATA-GPT5-HARMONY.md": true,
	"adding-a-provider.md": true,
	"ai-schema-normalize.md": true,
	"arktype-guide.md": true,
	"auth-broker-gateway.md": true,
	"bash-tool-runtime.md": true,
	"blob-artifact-architecture.md": true,
	"config-usage.md": true,
	"extension-loading.md": true,
	"fs-scan-cache-architecture.md": true,
	"gemini-manifest-extensions.md": true,
	"handoff-generation-pipeline.md": true,
	"install-id.md": true,
	"macos-signing-notarization.md": true,
	"mcp-protocol-transports.md": true,
	"mcp-runtime-lifecycle.md": true,
	"mnemosyne-memory-backend.md": true,
	"native-crates.md": true,
	"natives-addon-loader-runtime.md": true,
	"natives-architecture.md": true,
	"natives-binding-contract.md": true,
	"natives-build-release-debugging.md": true,
	"natives-media-system-utils.md": true,
	"natives-rust-task-cancellation.md": true,
	"natives-shell-pty-process.md": true,
	"natives-text-search-pipeline.md": true,
	"non-compaction-retry-policy.md": true,
	"notebook-tool-runtime.md": true,
	"plugin-manager-installer-plumbing.md": true,
	"porting-from-pi-mono.md": true,
	"porting-to-natives.md": true,
	"provider-endpoint-constraints.md": true,
	"provider-streaming-internals.md": true,
	"resolve-tool-runtime.md": true,
	"rulebook-matching-pipeline.md": true,
	"session-operations-export-share-fork-resume.md": true,
	"session-switching-and-recent-listing.md": true,
	"session-tree-plan.md": true,
	"slash-command-internals.md": true,
	"task-agent-discovery.md": true,
	"ttsr-injection-lifecycle.md": true,
	"tui-core-renderer.md": true,
	"tui-runtime-internals.md": true,
	"user-facing-packages.md": true,
};

const MAINTAINER_DOC_PREFIXES = ["toolconv/"];

/** isMaintainerDocPath reports whether a normalized docs-relative path is hidden by default. */
export function isMaintainerDocPath(docPath: string): boolean {
	return (
		Object.hasOwn(MAINTAINER_DOC_PATHS, docPath) || MAINTAINER_DOC_PREFIXES.some(prefix => docPath.startsWith(prefix))
	);
}
