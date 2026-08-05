import { existsSync } from "node:fs";
import * as path from "node:path";
/**
 * `omp ttsr` — inspect and test Time-Traveling Stream Rules and whole-file semantic rules.
 *
 * `omp ttsr test` feeds a snippet (inline, --file, or stdin) through the real
 * TTSR matching pipeline. Semantic rules evaluate the supplied whole snippet;
 * project references are used only when --file is the actual source file.
 * `omp ttsr list` shows every TTSR-registered rule and effective provider gates.
 * `omp ttsr scan` evaluates complete files in whole-file mode.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { ttsrHelp as commandHelp } from "../cli/command-help";
import {
	runTtsrCommand,
	TTSR_ACTIONS,
	TTSR_SOURCES,
	type TtsrCommandArgs,
	type TtsrScanArgs,
	type TtsrTestArgs,
} from "../cli/ttsr-cli";
import type { TtsrMatchSource } from "../export/ttsr";

export default class Ttsr extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "TTSR action",
			required: false,
			options: TTSR_ACTIONS,
		}),
		snippet: Args.string({
			description: "Inline snippet text to test (ttsr test) or directory to scan (ttsr scan)",
			required: false,
		}),
	};

	static flags = {
		file: Flags.string({
			description:
				"Snippet/source file path, or - for stdin (ttsr test; semantic references require the actual file)",
		}),
		rule: Flags.string({
			char: "r",
			description: "Rule markdown file to test in isolation (skips project rule loading)",
		}),
		source: Flags.string({
			description: "Match source: text, thinking, or tool (inferred from --file when omitted)",
			options: TTSR_SOURCES,
		}),
		tool: Flags.string({
			description: "Tool name when source is tool (e.g. edit, write); defaults to edit",
		}),
		path: Flags.string({
			char: "p",
			description: "Candidate file path for scope/glob matching and AST language inference",
		}),
		verbose: Flags.boolean({ char: "v", description: "Show every evaluated rule, not just triggered ones" }),
		json: Flags.boolean({ description: "Output JSON" }),
		"no-gitignore": Flags.boolean({ description: "Include files excluded by .gitignore (ttsr scan)" }),
		"max-bytes": Flags.integer({
			description: "Maximum file size to scan in bytes; 0 disables the limit (ttsr scan)",
		}),
	};

	static examples = [
		"omp ttsr list",
		"omp ttsr test 'const x: any = 1'",
		"omp ttsr test src/foo.ts",
		"omp ttsr test --file src/foo.ts",
		"omp ttsr test --file src/foo.ts --source text",
		"omp ttsr test --rule .omp/rules/no-any.md --source tool --path src/foo.ts 'const x: any = 1'",
		"echo 'Box::leak(&mut v)' | omp ttsr test --file - --path src/lib.rs",
		"omp ttsr test --rule .omp/rules/semantic.md --path src/foo.ts 'function foo() {}'",
		"omp ttsr test --rule .omp/rules/semantic.md --file src/foo.ts --verbose",
		"omp ttsr scan --json src/  # JSON reports mode=whole-file",
		"omp ttsr scan",
		"omp ttsr scan src/",
		"omp ttsr scan -r .omp/rules/no-any.md src/",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Ttsr);
		const action = (args.action ?? "list") as (typeof TTSR_ACTIONS)[number];

		// A positional that resolves to an existing file is a snippet file, not
		// inline text — so `omp ttsr test src/foo.ts` works without --file.
		// --file always wins over the positional.
		let file = flags.file;
		let snippet = args.snippet;
		if (action === "test" && snippet && !file) {
			const resolved = path.resolve(snippet);
			if (existsSync(resolved)) {
				file = resolved;
				snippet = undefined;
			}
		}

		const test: TtsrTestArgs | undefined =
			action === "test"
				? {
						snippet,
						file,
						rule: flags.rule,
						source: flags.source as TtsrMatchSource | undefined,
						tool: flags.tool,
						filePath: flags.path,
						verbose: flags.verbose,
					}
				: undefined;

		const scan: TtsrScanArgs | undefined =
			action === "scan"
				? {
						directory: args.snippet,
						rule: flags.rule,
						gitignore: !flags["no-gitignore"],
						maxBytes: flags["max-bytes"],
						verbose: flags.verbose,
					}
				: undefined;

		const cmd: TtsrCommandArgs = {
			action,
			test,
			scan,
			json: flags.json,
		};

		await runTtsrCommand(cmd);
	}
}
