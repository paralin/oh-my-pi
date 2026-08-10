import { untilAborted } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../session/tool-session";
import { resolveCmuxKind } from "./browser/cmux/rpc";
import { acquireBrowser, type BrowserKind, holdBrowser, releaseBrowser } from "./browser/registry";
import { resolveRelayKind } from "./browser/relay/kind";
import { type AcquireTabResult, acquireTab, getTab } from "./browser/tab-supervisor";
import { resolveToCwd } from "./path-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";

export {
	type AriaSnapshotOptions,
	buildAriaSnapshotScript,
	parseAriaRefSelector,
} from "./browser/aria/aria-snapshot";
export { cmuxSnapshotToObservation, mapWaitUntil, resolveCmuxKind, serializeEval } from "./browser/cmux/rpc";
export { CmuxSocketClient } from "./browser/cmux/socket-client";
export { extractReadableFromHtml, type ReadableFormat, type ReadableResult } from "./browser/readable";
export { DEFAULT_RELAY_URL, type RelayKind, resolveRelayKind } from "./browser/relay/kind";
export type { Observation, ObservationEntry } from "./browser/tab-protocol";

/** Input for one browser tab operation. */
export interface BrowserParams {
	action: "open" | "close" | "run";
	name?: string;
	url?: string;
	app?: {
		path?: string;
		cdp_url?: string;
		relay?: boolean;
		args?: string[];
		target?: string;
	};
	viewport?: { width: number; height: number; scale?: number };
	wait_until?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
	dialogs?: "accept" | "dismiss";
	code?: string;
	timeout?: number;
	all?: boolean;
	kill?: boolean;
}

/** The session facts needed to select and acquire a browser. */
export type BrowserSession = Pick<ToolSession, "cwd" | "settings" | "getSessionId">;

export function resolveBrowserKind(params: BrowserParams, session: BrowserSession): BrowserKind {
	const app = params.app;
	if (app?.cdp_url) {
		return { kind: "connected", cdpUrl: app.cdp_url.replace(/\/+$/, "") };
	}
	if (app?.path) {
		const exe = resolveToCwd(app.path, session.cwd);
		return { kind: "spawned", path: exe };
	}
	const relayUrl = session.settings.get("browser.relayUrl") as string | undefined;
	if (app?.relay) {
		const relayKind = resolveRelayKind({ settingEnabled: true, url: relayUrl });
		if (relayKind) return relayKind;
	}
	if (app?.relay !== false) {
		const relayKind = resolveRelayKind({
			settingEnabled: session.settings.get("browser.relay") as boolean | undefined,
			url: relayUrl,
		});
		if (relayKind) return relayKind;
	}
	const configuredCdpUrl = (session.settings.get("browser.cdpUrl") as string | undefined)?.trim();
	if (configuredCdpUrl) {
		return { kind: "connected", cdpUrl: configuredCdpUrl.replace(/\/+$/, "") };
	}
	const cmuxKind = resolveCmuxKind({
		settingEnabled: session.settings.get("browser.cmux") as boolean | undefined,
	});
	if (cmuxKind) return cmuxKind;
	return { kind: "headless", headless: session.settings.get("browser.headless") as boolean };
}

/**
 * Acquire or reuse a named tab. The caller supplies one operation deadline;
 * the acquisition lease keeps a newly-created browser alive until the tab is
 * published or the operation rolls back.
 */
export async function openBrowserTab(
	session: BrowserSession,
	name: string,
	params: BrowserParams,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<AcquireTabResult> {
	throwIfAborted(signal);
	const kind = resolveBrowserKind(params, session);
	const existing = getTab(name);
	if (existing && !sameBrowserKind(existing.browser.kind, kind)) {
		throw new ToolError(
			`Tab ${JSON.stringify(name)} is bound to a different browser (${describeKind(existing.browser.kind)}). Close it first.`,
		);
	}

	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const openSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		const browser = await untilAborted(openSignal, () =>
			acquireBrowser(kind, {
				cwd: session.cwd,
				viewport: params.viewport
					? {
							width: params.viewport.width,
							height: params.viewport.height,
							deviceScaleFactor: params.viewport.scale,
						}
					: undefined,
				appArgs: params.app?.args,
				signal: openSignal,
			}),
		);
		holdBrowser(browser);
		try {
			return await untilAborted(openSignal, () =>
				acquireTab(name, browser, {
					url: params.url,
					waitUntil: params.wait_until,
					viewport: params.viewport
						? {
								width: params.viewport.width,
								height: params.viewport.height,
								deviceScaleFactor: params.viewport.scale,
							}
						: undefined,
					target: params.app?.target,
					timeoutMs,
					dialogs: params.dialogs,
					signal: openSignal,
					ownerSessionId: session.getSessionId?.() ?? undefined,
				}),
			);
		} finally {
			await releaseBrowser(browser, { kill: false });
		}
	} catch (error) {
		if (signal?.aborted) throw error instanceof ToolAbortError ? error : new ToolAbortError();
		if (timeoutSignal.aborted) throw new ToolError(`Browser open timed out after ${timeoutMs}ms`);
		throw error;
	}
}

function describeKind(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless ${kind.headless ? "hidden" : "visible"}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
		case "relay":
			return `relay:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.surface ?? "split"}`;
	}
}

function sameBrowserKind(a: BrowserKind, b: BrowserKind): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "headless" && b.kind === "headless") return a.headless === b.headless;
	if (a.kind === "spawned" && b.kind === "spawned") return a.path === b.path;
	if (a.kind === "connected" && b.kind === "connected") return a.cdpUrl === b.cdpUrl;
	if (a.kind === "relay" && b.kind === "relay") return a.cdpUrl === b.cdpUrl;
	if (a.kind === "cmux" && b.kind === "cmux") return a.socketPath === b.socketPath;
	return false;
}
