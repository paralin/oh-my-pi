import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BashExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/bash-execution";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createContainer() {
	return {
		children: [] as unknown[],
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
}

function createCwdContext(sourceDir: string, isStreaming = false) {
	const state = {
		cwd: sourceDir,
		streaming: isStreaming,
		executedCwds: [] as string[],
		transition: [] as string[],
	};
	const executeBash = vi.fn(async (command: string) => {
		state.executedCwds.push(state.cwd);
		return {
			output: command === "pwd" ? `${state.cwd}\n` : "ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: state.cwd.length,
			outputLines: 1,
			outputBytes: state.cwd.length,
			workingDir: state.cwd,
		};
	});
	const moveTo = vi.fn(async (cwd: string) => {
		state.transition.push("move");
		state.cwd = cwd;
	});
	const abort = vi.fn(async () => {
		state.transition.push("abort");
		state.streaming = false;
	});
	// Stands in for AgentSession.moveSession: suspend the session services, abort
	// a live turn, then commit the relocation through the session manager.
	const moveSession = vi.fn(async (cwd: string) => {
		state.transition.push("suspend");
		if (state.streaming) await abort();
		await moveTo(cwd);
		state.transition.push("resume");
	});
	const pendingMessagesContainer = createContainer();
	const present = vi.fn();
	const ctx = {
		session: {
			get isStreaming() {
				return state.streaming;
			},
			executeBash,
			abort,
			moveSession,
		},
		sessionManager: {
			getCwd: () => state.cwd,
			moveTo,
		},
		chatContainer: createContainer(),
		pendingMessagesContainer,
		pendingBashComponents: [],
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		present,
		showError: vi.fn(),
		showWarning: vi.fn(),
		applyCwdChange: vi.fn(async (cwd: string) => {
			expect(state.cwd).toBe(cwd);
		}),
		updateEditorBorderColor: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
	} as unknown as InteractiveModeContext;
	return { ctx, abort, executeBash, moveSession, moveTo, pendingMessagesContainer, present, state };
}

describe("bash shortcut command", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("runs interactive ! commands through the configured user shell", async () => {
		const executeBash = vi.fn().mockResolvedValue({
			output: "ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 2,
			outputLines: 1,
			outputBytes: 2,
		});
		const ctx = {
			session: {
				isStreaming: false,
				executeBash,
			},
			sessionManager: {
				getCwd: () => "/tmp",
			},
			chatContainer: createContainer(),
			pendingMessagesContainer: createContainer(),
			pendingBashComponents: [],
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			present: vi.fn(),
			showError: vi.fn(),
			applyCwdChange: vi.fn(async () => {}),
			updateEditorBorderColor: vi.fn(),
			reloadTodos: vi.fn(async () => {}),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleBashCommand("echo hi");

		expect(executeBash).toHaveBeenCalledWith("echo hi", expect.any(Function), {
			excludeFromContext: false,
			useUserShell: true,
		});
	});

	it("persists standalone and bare cd before the next user-shell command", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-cd-source-"));
		const childDir = path.join(sourceDir, "child");
		await fs.mkdir(childDir);
		try {
			const { ctx, executeBash, state } = createCwdContext(sourceDir);
			executeBash.mockImplementationOnce(async () => {
				state.executedCwds.push(state.cwd);
				return {
					output: "",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					totalLines: 0,
					totalBytes: 0,
					outputLines: 0,
					outputBytes: 0,
					workingDir: childDir,
				};
			});
			executeBash.mockImplementationOnce(async () => {
				state.executedCwds.push(state.cwd);
				return {
					output: "",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					totalLines: 0,
					totalBytes: 0,
					outputLines: 0,
					outputBytes: 0,
					workingDir: sourceDir,
				};
			});
			const controller = new CommandController(ctx);

			await controller.handleBashCommand("cd child");
			await controller.handleBashCommand("cd");
			await controller.handleBashCommand("pwd");

			expect(state.cwd).toBe(sourceDir);
			expect(state.executedCwds).toEqual([sourceDir, childDir, sourceDir]);
			expect(executeBash).toHaveBeenCalledTimes(3);
			expect(executeBash).toHaveBeenNthCalledWith(1, "cd child", expect.any(Function), {
				excludeFromContext: false,
				useUserShell: true,
			});
			expect(executeBash).toHaveBeenNthCalledWith(2, "cd", expect.any(Function), {
				excludeFromContext: false,
				useUserShell: true,
			});
			expect(ctx.applyCwdChange).toHaveBeenNthCalledWith(1, childDir);
			expect(ctx.applyCwdChange).toHaveBeenNthCalledWith(2, sourceDir);
			expect(ctx.updateEditorBorderColor).toHaveBeenCalledTimes(2);
			expect(ctx.reloadTodos).toHaveBeenCalledTimes(2);
			expect(ctx.showError).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("suspends and aborts a wake that starts during a standalone cd", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-cd-wake-"));
		const childDir = path.join(sourceDir, "child");
		await fs.mkdir(childDir);
		try {
			const { ctx, abort, executeBash, moveSession, moveTo, state } = createCwdContext(sourceDir);
			executeBash.mockImplementationOnce(async () => {
				state.executedCwds.push(state.cwd);
				// A cron wake fires while the interactive shell is still running.
				state.streaming = true;
				return {
					output: "",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					totalLines: 0,
					totalBytes: 0,
					outputLines: 0,
					outputBytes: 0,
					workingDir: childDir,
				};
			});
			const controller = new CommandController(ctx);

			await controller.handleBashCommand("cd child");

			expect(moveSession).toHaveBeenCalledWith(childDir);
			expect(abort).toHaveBeenCalledTimes(1);
			expect(moveTo).toHaveBeenCalledTimes(1);
			expect(state.transition).toEqual(["suspend", "abort", "move", "resume"]);
			expect(state.cwd).toBe(childDir);
			expect(ctx.applyCwdChange).toHaveBeenCalledWith(childDir);
			expect(ctx.showError).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("does not adopt cwd from a non-cd bash command", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-cwd-sync-"));
		const childDir = path.join(sourceDir, "child");
		await fs.mkdir(childDir);
		try {
			const { ctx, executeBash, state } = createCwdContext(sourceDir);
			executeBash.mockImplementationOnce(async () => {
				state.executedCwds.push(state.cwd);
				return {
					output: "",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					totalLines: 0,
					totalBytes: 0,
					outputLines: 0,
					outputBytes: 0,
					workingDir: childDir,
				};
			});
			const controller = new CommandController(ctx);

			await controller.handleBashCommand("pushd child >/dev/null");

			expect(state.cwd).toBe(sourceDir);
			expect(state.executedCwds).toEqual([sourceDir]);
			expect(executeBash).toHaveBeenCalledTimes(1);
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(ctx.updateEditorBorderColor).not.toHaveBeenCalled();
			expect(ctx.reloadTodos).not.toHaveBeenCalled();
			expect(ctx.showWarning).not.toHaveBeenCalled();
			expect(ctx.showError).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("rejects simple cd while streaming before queuing a bash block", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-cd-streaming-"));
		try {
			const { ctx, executeBash, pendingMessagesContainer, present, state } = createCwdContext(sourceDir, true);
			const controller = new CommandController(ctx);

			await controller.handleBashCommand("cd child");

			expect(state.cwd).toBe(sourceDir);
			expect(executeBash).not.toHaveBeenCalled();
			expect(present).not.toHaveBeenCalled();
			expect(pendingMessagesContainer.children).toHaveLength(0);
			expect(ctx.pendingBashComponents).toHaveLength(0);
			expect(ctx.showWarning).toHaveBeenCalledWith(expect.stringContaining("response"));
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("does not adopt cwd or warn for a non-cd command while streaming", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-cwd-deferred-"));
		const childDir = path.join(sourceDir, "child");
		await fs.mkdir(childDir);
		try {
			const { ctx, executeBash, pendingMessagesContainer, state } = createCwdContext(sourceDir, true);
			executeBash.mockImplementationOnce(async () => ({
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 0,
				totalBytes: 0,
				outputLines: 0,
				outputBytes: 0,
				workingDir: childDir,
			}));
			const controller = new CommandController(ctx);

			await controller.handleBashCommand("pushd child >/dev/null");

			expect(state.cwd).toBe(sourceDir);
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(pendingMessagesContainer.children).toHaveLength(1);
			expect(ctx.pendingBashComponents).toHaveLength(1);
			expect(ctx.showWarning).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("finalizes successful output before reporting a standalone cd refresh failure", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-cwd-refresh-error-"));
		const childDir = path.join(sourceDir, "child");
		await fs.mkdir(childDir);
		try {
			const { ctx, executeBash, present, state } = createCwdContext(sourceDir);
			executeBash.mockImplementationOnce(async () => ({
				output: "final output",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 12,
				outputLines: 1,
				outputBytes: 12,
				workingDir: childDir,
			}));
			ctx.applyCwdChange = vi.fn(async () => {
				throw new Error("refresh failed");
			});
			const controller = new CommandController(ctx);

			await controller.handleBashCommand("cd child");

			const component = present.mock.calls[0]?.[0];
			expect(component).toBeInstanceOf(BashExecutionComponent);
			expect((component as BashExecutionComponent).getOutput()).toContain("final output");
			expect(state.cwd).toBe(childDir);
			expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("completed, but"));
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});
});
