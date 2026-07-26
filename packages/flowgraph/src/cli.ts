#!/usr/bin/env bun
/**
 * `flowgraph` CLI.
 *
 * `run` executes one walk and writes its trajectory; `view` serves the graph
 * with the current node highlighted from that trajectory.
 */
import * as path from "node:path";
import { parseArgs } from "node:util";
import { loadGraph } from "./graph";
import { resolveModel } from "./model";
import { TrajectoryWriter } from "./trajectory";
import { serveView } from "./view";
import { walk } from "./walk";

const usage = `flowgraph run  --graph <file> --task "<goal>" --dir <target> [--model <provider:id>] [--trajectory <file>]
flowgraph view --graph <file> --trajectory <file> [--port <n>]`;

async function runCommand(argv: string[]): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: {
			graph: { type: "string" },
			task: { type: "string" },
			dir: { type: "string" },
			model: { type: "string", default: "openrouter:anthropic/claude-sonnet-4.5" },
			trajectory: { type: "string" },
			"max-tokens": { type: "string" },
		},
	});
	if (!values.graph || !values.task || !values.dir) {
		process.stderr.write(`${usage}\n`);
		return 2;
	}

	const dir = path.resolve(values.dir);
	const indexed = await loadGraph(path.resolve(values.graph));
	const { model } = resolveModel(values.model);
	const walkId = `${indexed.graph.id}-${Date.now().toString(36)}`;
	const trajectoryPath = path.resolve(values.trajectory ?? path.join(dir, `${walkId}.trajectory.jsonl`));
	const trajectory = new TrajectoryWriter(trajectoryPath);

	trajectory.write({
		type: "walk_start",
		walkId,
		graphId: indexed.graph.id,
		task: values.task,
		dir,
		model: `${model.provider}:${model.id}`,
	});
	process.stdout.write(`walk ${walkId} -> ${trajectoryPath}\n`);

	const result = await walk({
		graph: indexed,
		walkId,
		dir,
		task: values.task,
		model,
		trajectory,
		maxTokens: values["max-tokens"] ? Number(values["max-tokens"]) : undefined,
		onProgress: line => process.stdout.write(`${line}\n`),
	});
	await trajectory.flush();

	process.stdout.write(
		`status=${result.status} nodes=${result.nodesEntered} tokens=${result.usage.totalTokens} cost=$${result.usage.cost.toFixed(4)}\n`,
	);
	if (result.error) process.stderr.write(`${result.error}\n`);
	return result.status === "done" ? 0 : 1;
}

async function viewCommand(argv: string[]): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: {
			graph: { type: "string" },
			trajectory: { type: "string" },
			port: { type: "string", default: "8787" },
		},
	});
	if (!values.graph || !values.trajectory) {
		process.stderr.write(`${usage}\n`);
		return 2;
	}
	const url = await serveView({
		graphPath: path.resolve(values.graph),
		trajectoryPath: path.resolve(values.trajectory),
		port: Number(values.port),
	});
	process.stdout.write(`viewing at ${url}\n`);
	await new Promise(() => {});
	return 0;
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
	case "run":
		process.exit(await runCommand(rest));
		break;
	case "view":
		process.exit(await viewCommand(rest));
		break;
	default:
		process.stderr.write(`${usage}\n`);
		process.exit(2);
}
