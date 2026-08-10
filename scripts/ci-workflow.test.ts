import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

const workflowPath = path.join(import.meta.dir, "..", ".github", "workflows", "ci.yml");

async function readWorkflow() {
	return readFile(workflowPath, "utf8");
}

function job(workflow: string, name: string) {
	const start = workflow.indexOf(`   ${name}:\n`);
	const rest = workflow.slice(start + `   ${name}:\n`.length);
	const next = rest.search(/\n {3}[a-z_]+:\n/);
	return workflow.slice(start, next === -1 ? undefined : start + `   ${name}:\n`.length + next);
}

describe("manual binary proof workflow", () => {
	it("runs all seven binary smoke legs without enabling a release", async () => {
		const workflow = await readWorkflow();
		const nativeAddons = job(workflow, "native_addons");
		const linux = job(workflow, "release_binary");
		const darwin = job(workflow, "release_binary_darwin");
		const windowsSmoke = job(workflow, "smoke_release_binary_windows");
		const targets = [...linux.matchAll(/target_id: ([\w-]+)/g), ...darwin.matchAll(/target_id: ([\w-]+)/g)].map(
			([, target]) => target,
		);

		expect(workflow).toContain("build_binaries:");
		expect(workflow).toContain("build_ref:");
		for (const buildJob of [nativeAddons, linux, darwin])
			expect(buildJob).toContain("ref: $" + "{{ inputs.build_ref || github.sha }}");
		expect(nativeAddons).toContain("github.event_name == 'pull_request' || inputs.build_binaries");
		expect(nativeAddons).toContain("Install Bazelisk for hosted binary proof");
		expect(nativeAddons).toContain("5a408715e932c0250d28bd84555f12edbf70117de42f9181691c736eacc4a992");
		expect(linux).toContain("needs.release_metadata.outputs.is-release == 'true' || inputs.build_binaries");
		expect(darwin).toContain("needs.release_metadata.outputs.is-release == 'true' || inputs.build_binaries");
		expect(targets).toHaveLength(7);
		expect(new Set(targets)).toHaveLength(7);
		expect(linux).toContain("Smoke release binary");
		expect(darwin).toContain("Smoke release binary");
		expect(windowsSmoke).toContain("inputs.build_binaries");
		expect(windowsSmoke).toContain("needs: [release_binary]");
		expect(windowsSmoke).toContain("runs-on: windows-2022");
		expect(windowsSmoke).toContain("name: omp-binary-win32-x64");
		expect(windowsSmoke).toContain("& $binary.FullName --smoke-test");
	});

	it("keeps dispatches and publish actions separate", async () => {
		const workflow = await readWorkflow();

		const metadata = job(workflow, "release_metadata");
		expect(metadata).toContain('[ "$' + '{{ inputs.build_binaries }}" != "true" ]');
		expect(job(workflow, "check")).toContain("!inputs.build_binaries");
		expect(job(workflow, "rust_validate")).toContain("!inputs.build_binaries");
		for (const name of [
			"test_workspace",
			"test_coding_agent_singleton",
			"test_ts_native",
			"test_coding_agent_ui",
			"test_coding_agent_runtime",
			"test_coding_agent_native",
			"test_smoke",
			"install_methods",
		])
			expect(job(workflow, name)).toContain("!inputs.build_binaries");
		expect(metadata).toContain("refs/tags/v[0-9]*");
		for (const name of [
			"release_gate",
			"release_native_leaves",
			"release_github",
			"release_github_verify",
			"release_npm",
			"release_brew",
		]) {
			const releaseJob = job(workflow, name);
			expect(releaseJob).toContain("needs.release_metadata.outputs.is-release == 'true'");
			expect(releaseJob).not.toContain("inputs.build_binaries");
		}
		expect(job(workflow, "release_binary_darwin")).toContain(
			"if: needs.release_metadata.outputs.is-release == 'true' && env.MACOS_SIGNING == 'true'",
		);
		expect(workflow).toContain('UV_VERSION: "0.12.3"');
		expect(workflow.match(/astral-sh\/setup-uv@94527f2e458b27549849d47d273a16bec83a01e9/g)).toHaveLength(3);
		const linux = job(workflow, "release_binary");
		expect(linux).toContain("x86_64) uv_arch=x86_64");
		expect(linux).toContain("aarch64) uv_arch=aarch64");
		expect(linux).toContain("uv-$" + "{uv_arch}-unknown-linux-musl.tar.gz");
	});
});
