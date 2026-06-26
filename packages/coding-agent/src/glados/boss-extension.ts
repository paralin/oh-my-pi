import { ThinkingLevel, type ThinkingLevel as ThinkingLevelValue } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ExtensionFactory } from "../extensibility/extensions/types";
import { buildSkillPromptMessage, getActiveSkills } from "../extensibility/skills";

export const GLADOS_BOSS_EXTENSION_ID = "<builtin:glados-boss>";
export const GLADOS_BOSS_EXTENSION_VERSION = 1;
export const GLADOS_BOSS_FLAG = "boss";
export const GLADOS_BOSS_PROVIDER = "glados";
export const GLADOS_BOSS_MODEL_ID = "codex-boss";
export const GLADOS_BOSS_MODEL_SELECTOR = `${GLADOS_BOSS_PROVIDER}/${GLADOS_BOSS_MODEL_ID}`;
export const GLADOS_BOSS_MARKER_TYPE = "glados:boss-mode";
export const GLADOS_BOSS_PROVIDER_DECISION_TYPE = "glados:boss-provider-decision";
export const GLADOS_BOSS_STATUS_TOOL = "glados_boss_status";
export const GLADOS_BOSS_AUTOLOAD_SKILLS = ["orient", "quorra", "quorra-auto", "boss"] as const;

const GLADOS_BOSS_THINKING_LEVEL: ThinkingLevelValue = ThinkingLevel.XHigh;
let gladosBossSkillContextCache: { key: string; value: string | undefined } | undefined;

const GLADOS_BOSS_SYSTEM_PROMPT = `# GLaDOS Boss mode

You are running as the root GLaDOS Boss inside an ordinary Oh My Pi interactive session. Keep the operator as the primary conversation partner. Use OMP's native session, Agent Hub, provider, tool, transcript, and child-lane machinery; do not invent a second supervisor runtime.

GLaDOS owns Boss policy: scratch-first continuity, proof-owner routing, provider-route selection, Checkpoint/Evidence readback, and closeout interpretation. Dispatch child lanes through OMP task machinery or the GLaDOS headless child wrapper when a worker lane is needed; do not launch the root TUI from GLaDOS.

No commits, pushes, branch changes, live-service changes, credential/account mutations, or destructive actions are authorized unless the operator gives that authority explicitly in the current conversation. Record blockers and return conditions instead of silently widening authority.`;

function registerBossProvider(pi: Parameters<ExtensionFactory>[0]): void {
	const codex = getBundledModel("openai-codex", "gpt-5.5") ?? getBundledModel("openai-codex", "gpt-5.4");
	if (!codex?.baseUrl || !codex.api) {
		return;
	}

	pi.registerProvider(GLADOS_BOSS_PROVIDER, {
		baseUrl: codex.baseUrl,
		oauth: {
			name: "GLaDOS Boss Codex",
			async login() {
				throw new Error("Configure GLaDOS Boss Codex credentials through the GLaDOS-owned provider route.");
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		},
		models: [
			{
				id: GLADOS_BOSS_MODEL_ID,
				name: "GLaDOS Codex Boss",
				api: codex.api,
				reasoning: codex.reasoning,
				thinking: codex.thinking,
				input: [...codex.input],
				cost: { ...codex.cost },
				contextWindow: codex.contextWindow ?? 272_000,
				maxTokens: codex.maxTokens ?? 128_000,
				compat: codex.compat,
			},
		],
	});
}

async function loadGladosBossSkillContext(): Promise<string | undefined> {
	const activeSkills = new Map(getActiveSkills().map(skill => [skill.name, skill]));
	const selectedSkills = GLADOS_BOSS_AUTOLOAD_SKILLS.map(name => activeSkills.get(name)).filter(
		skill => skill !== undefined,
	);
	const cacheKey = selectedSkills.map(skill => `${skill.name}\0${skill.filePath}`).join("\0");
	if (gladosBossSkillContextCache?.key === cacheKey) {
		return gladosBossSkillContextCache.value;
	}

	const sections: string[] = [];
	for (const skill of selectedSkills) {
		const built = await buildSkillPromptMessage(skill, "");
		sections.push(`<boss-skill name="${skill.name}">\n${built.message}\n</boss-skill>`);
	}

	const value = sections.length === 0 ? undefined : ["# GLaDOS Boss preloaded skills", ...sections].join("\n\n");
	gladosBossSkillContextCache = { key: cacheKey, value };
	return value;
}

export const createGladosBossExtension: ExtensionFactory = pi => {
	pi.setLabel("GLaDOS Boss");
	pi.registerFlag(GLADOS_BOSS_FLAG, {
		type: "boolean",
		description: "start the root interactive session in GLaDOS Boss mode",
	});
	registerBossProvider(pi);

	pi.registerTool({
		name: GLADOS_BOSS_STATUS_TOOL,
		label: "Boss status",
		description: "Report the current GLaDOS Boss-mode route, cwd, model, and active tools.",
		parameters: pi.zod.object({}),
		approval: "read",
		defaultInactive: true,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unset";
			return {
				content: [
					{
						type: "text",
						text: [
							"boss=true",
							`cwd=${ctx.cwd}`,
							`provider_route=${GLADOS_BOSS_MODEL_SELECTOR}`,
							`model=${model}`,
							`tools=${pi.getActiveTools().join(",")}`,
						].join("\n"),
					},
				],
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag(GLADOS_BOSS_FLAG) !== true) {
			return;
		}

		const route = GLADOS_BOSS_MODEL_SELECTOR;
		const model = ctx.models.resolve(route);
		const selected = model ? await pi.setModel(model) : false;
		if (!model || !selected) {
			pi.appendEntry(GLADOS_BOSS_PROVIDER_DECISION_TYPE, {
				mode: "boss",
				cwd: ctx.cwd,
				providerRoute: route,
				reason: model ? "auth-unavailable" : "model-unavailable",
				timestamp: new Date().toISOString(),
			});
		}

		pi.setThinkingLevel(GLADOS_BOSS_THINKING_LEVEL);

		const activeTools = new Set(pi.getActiveTools());
		activeTools.add(GLADOS_BOSS_STATUS_TOOL);
		await pi.setActiveTools([...activeTools]);

		if (!pi.getSessionName()) {
			await pi.setSessionName(`Boss: ${ctx.cwd}`);
		}

		pi.appendEntry(GLADOS_BOSS_MARKER_TYPE, {
			mode: "boss",
			cwd: ctx.cwd,
			extensionVersion: GLADOS_BOSS_EXTENSION_VERSION,
			providerRoute: route,
			providerSelected: selected,
			timestamp: new Date().toISOString(),
		});
	});

	pi.on("before_agent_start", async event => {
		if (pi.getFlag(GLADOS_BOSS_FLAG) !== true) {
			return;
		}

		const skillContext = await loadGladosBossSkillContext();
		return {
			systemPrompt: skillContext
				? [...event.systemPrompt, GLADOS_BOSS_SYSTEM_PROMPT, skillContext]
				: [...event.systemPrompt, GLADOS_BOSS_SYSTEM_PROMPT],
		};
	});
};

export default createGladosBossExtension;
