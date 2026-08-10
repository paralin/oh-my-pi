/**
 * Time Traveling Stream Rules (TTSR) Manager.
 *
 * Regex rules interrupt a matching assistant text, thinking, or IPython code
 * stream so the rule guidance can be injected before the turn continues.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { compileRuleCondition, type Rule } from "../capability/rule";
import type { TtsrSettings } from "../config/settings";

export type TtsrMatchSource = "text" | "thinking" | "tool";

/** Context about the stream content currently being checked against TTSR rules. */
export interface TtsrMatchContext {
	source: TtsrMatchSource;
	/** Tool name for tool argument deltas. New provider turns use `ipython`. */
	toolName?: string;
	/** Stable key that isolates buffers, for example an IPython call ID. */
	streamKey?: string;
}

interface ToolScope {
	toolName?: string;
}

interface TtsrScope {
	allowText: boolean;
	allowThinking: boolean;
	allowAnyTool: boolean;
	toolScopes: ToolScope[];
}

interface TtsrEntry {
	rule: Rule;
	conditions: RegExp[];
	scope: TtsrScope;
}

/** Tracks when a rule was last injected (for repeat gating). */
interface InjectionRecord {
	/** Message count (turn index) when the rule was last injected. */
	lastInjectedAt: number;
}

const DEFAULT_SETTINGS: Required<TtsrSettings> = {
	enabled: true,
	contextMode: "discard",
	interruptMode: "always",
	repeatMode: "once",
	repeatGap: 10,
	builtinRules: true,
	disabledRules: [],
};

const DEFAULT_SCOPE: TtsrScope = {
	allowText: true,
	allowThinking: false,
	allowAnyTool: true,
	toolScopes: [],
};

export class TtsrManager {
	readonly #settings: Required<TtsrSettings>;
	readonly #rules = new Map<string, TtsrEntry>();
	readonly #injectionRecords = new Map<string, InjectionRecord>();
	readonly #buffers = new Map<string, string>();
	#messageCount = 0;
	#canMatchText = false;
	#canMatchThinking = false;

	constructor(settings?: TtsrSettings) {
		this.#settings = { ...DEFAULT_SETTINGS, ...settings };
	}

	/** Check if a rule can be triggered based on repeat settings. */
	#canTrigger(ruleName: string): boolean {
		const record = this.#injectionRecords.get(ruleName);
		if (!record) return true;
		if (this.#settings.repeatMode === "once") return false;
		return this.#messageCount - record.lastInjectedAt >= this.#settings.repeatGap;
	}

	#compileConditions(rule: Rule): RegExp[] {
		const compiled: RegExp[] = [];
		for (const pattern of rule.condition ?? []) {
			try {
				compiled.push(compileRuleCondition(pattern));
			} catch (error) {
				logger.warn("TTSR condition has invalid regex pattern, skipping condition", {
					ruleName: rule.name,
					pattern,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return compiled;
	}

	#parseToolScopeToken(token: string): ToolScope | undefined {
		const match = /^(?:(?:tool):(?<tool>[a-z0-9_-]+)|(?<bare>[a-z0-9_-]+))$/i.exec(token);
		if (!match) return undefined;
		const toolName = (match.groups?.tool ?? match.groups?.bare)?.trim().toLowerCase();
		return toolName ? { toolName } : undefined;
	}

	#buildScope(rule: Rule): TtsrScope {
		if (!rule.scope || rule.scope.length === 0) {
			return {
				allowText: DEFAULT_SCOPE.allowText,
				allowThinking: DEFAULT_SCOPE.allowThinking,
				allowAnyTool: DEFAULT_SCOPE.allowAnyTool,
				toolScopes: [...DEFAULT_SCOPE.toolScopes],
			};
		}

		const scope: TtsrScope = {
			allowText: false,
			allowThinking: false,
			allowAnyTool: false,
			toolScopes: [],
		};
		for (const rawToken of rule.scope) {
			const token = rawToken.trim();
			const normalizedToken = token.toLowerCase();
			if (token.length === 0) continue;
			if (normalizedToken === "text") {
				scope.allowText = true;
				continue;
			}
			if (normalizedToken === "thinking") {
				scope.allowThinking = true;
				continue;
			}
			if (normalizedToken === "tool" || normalizedToken === "toolcall") {
				scope.allowAnyTool = true;
				continue;
			}
			const toolScope = this.#parseToolScopeToken(token);
			if (!toolScope) {
				logger.warn("TTSR scope token is invalid, skipping token", { ruleName: rule.name, token: rawToken });
				continue;
			}
			scope.toolScopes.push(toolScope);
		}
		return scope;
	}

	#hasReachableScope(scope: TtsrScope): boolean {
		return scope.allowText || scope.allowThinking || scope.allowAnyTool || scope.toolScopes.length > 0;
	}

	#bufferKey(context: TtsrMatchContext): string {
		if (context.streamKey && context.streamKey.trim().length > 0) return context.streamKey;
		if (context.source !== "tool") return context.source;
		const toolName = context.toolName?.trim().toLowerCase();
		return toolName ? `tool:${toolName}` : "tool";
	}

	#matchesScope(entry: TtsrEntry, context: TtsrMatchContext): boolean {
		if (context.source === "text") return entry.scope.allowText;
		if (context.source === "thinking") return entry.scope.allowThinking;
		if (entry.scope.allowAnyTool) return true;
		const toolName = context.toolName?.trim().toLowerCase();
		return entry.scope.toolScopes.some(toolScope => toolScope.toolName === toolName);
	}

	#matchesCondition(entry: TtsrEntry, streamBuffer: string): boolean {
		for (const condition of entry.conditions) {
			condition.lastIndex = 0;
			if (condition.test(streamBuffer)) return true;
		}
		return false;
	}

	/** Add a TTSR rule to be monitored. */
	addRule(rule: Rule): boolean {
		if (!this.#settings.enabled || this.#rules.has(rule.name)) return false;
		const conditions = this.#compileConditions(rule);
		if (conditions.length === 0) return false;

		const scope = this.#buildScope(rule);
		if (!this.#hasReachableScope(scope)) {
			logger.warn("TTSR scope excludes all streams, skipping rule", { ruleName: rule.name, scope: rule.scope });
			return false;
		}
		this.#rules.set(rule.name, { rule, conditions, scope });
		if (scope.allowText) this.#canMatchText = true;
		if (scope.allowThinking) this.#canMatchThinking = true;
		logger.debug("TTSR rule registered", {
			ruleName: rule.name,
			conditions: rule.condition,
			scope: rule.scope,
		});
		return true;
	}

	/**
	 * Add a stream chunk to its scoped buffer and return matching rules.
	 *
	 * Buffers are isolated by source or IPython call key so matches do not bleed
	 * across assistant prose, thinking, and unrelated code cells.
	 */
	checkDelta(delta: string, context: TtsrMatchContext): Rule[] {
		if (context.source === "text" && !this.#canMatchText) return [];
		if (context.source === "thinking" && !this.#canMatchThinking) return [];
		const bufferKey = this.#bufferKey(context);
		const nextBuffer = `${this.#buffers.get(bufferKey) ?? ""}${delta}`;
		this.#buffers.set(bufferKey, nextBuffer);
		return this.#matchBuffer(nextBuffer, context);
	}

	#matchBuffer(buffer: string, context: TtsrMatchContext): Rule[] {
		if (!this.#settings.enabled) return [];
		const matches: Rule[] = [];
		for (const [name, entry] of this.#rules) {
			if (!this.#canTrigger(name)) continue;
			if (!this.#matchesScope(entry, context) || !this.#matchesCondition(entry, buffer)) continue;
			matches.push(entry.rule);
			logger.debug("TTSR condition matched", {
				ruleName: name,
				conditions: entry.rule.condition,
				source: context.source,
				toolName: context.toolName,
			});
		}
		return matches;
	}

	/** Mark rules as injected (won't trigger again until conditions allow). */
	markInjected(rulesToMark: Rule[]): void {
		this.markInjectedByNames(rulesToMark.map(rule => rule.name));
	}

	/** Mark rule names as injected (won't trigger again until conditions allow). */
	markInjectedByNames(ruleNames: string[]): void {
		for (const rawName of ruleNames) {
			const ruleName = rawName.trim();
			if (ruleName.length === 0) continue;
			const record = this.#injectionRecords.get(ruleName);
			if (!record) this.#injectionRecords.set(ruleName, { lastInjectedAt: this.#messageCount });
			else record.lastInjectedAt = this.#messageCount;
			logger.debug("TTSR rule marked as injected", {
				ruleName,
				messageCount: this.#messageCount,
				repeatMode: this.#settings.repeatMode,
			});
		}
	}

	/** Get names of all injected rules (for persistence). */
	getInjectedRuleNames(): string[] {
		return Array.from(this.#injectionRecords.keys());
	}

	/** Restore injected state from a list of rule names. */
	restoreInjected(ruleNames: string[]): void {
		for (const name of ruleNames) this.#injectionRecords.set(name, { lastInjectedAt: 0 });
		if (ruleNames.length > 0) logger.debug("TTSR injected state restored", { ruleNames });
	}

	/** Reset stream buffers at the start of a new turn. */
	resetBuffer(): void {
		this.#buffers.clear();
	}

	/** Check if any TTSR rules are registered. */
	hasRules(): boolean {
		return this.#settings.enabled && this.#rules.size > 0;
	}

	/** All rules currently registered for TTSR monitoring, in registration order. */
	getRules(): Rule[] {
		return Array.from(this.#rules.values(), entry => entry.rule);
	}

	/** Increment message counter after each completed turn. */
	incrementMessageCount(): void {
		this.#messageCount++;
	}

	/** Get the completed-turn count. */
	getMessageCount(): number {
		return this.#messageCount;
	}

	/** Get the effective TTSR settings. */
	getSettings(): Required<TtsrSettings> {
		return this.#settings;
	}
}
