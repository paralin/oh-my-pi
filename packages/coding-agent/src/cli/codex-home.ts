import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CODEX_HOME_ENV = "CODEX_HOME";
export const OPENAI_CODEX_OAUTH_TOKEN_ENV = "OPENAI_CODEX_OAUTH_TOKEN";

export interface CodexHomeSpec {
	name?: string;
	path: string;
}

export interface CodexHomeCredential extends CodexHomeSpec {
	authPath: string;
	accessToken: string;
	refreshToken?: string;
	accountId?: string;
	email?: string;
}

export interface CodexHomeAuthResult {
	applied: boolean;
	codexHome?: string;
	authPath?: string;
	accessToken?: string;
	credentials: CodexHomeCredential[];
	reason?: "codex-home-unset" | "auth-file-unreadable" | "access-token-missing";
}

export interface ApplyCodexHomeAuthChainOptions {
	codexHomeFlag?: string;
	codexHomeChainFlag?: string;
	configuredHomes?: unknown;
}

function expandHome(input: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return input;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function parseCodexHomeString(value: string): CodexHomeSpec | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const separator = trimmed.indexOf("=");
	if (separator > 0) {
		const name = trimmed.slice(0, separator).trim();
		const homePath = trimmed.slice(separator + 1).trim();
		if (!homePath) return undefined;
		return { name: name || undefined, path: expandHome(homePath) };
	}
	return { path: expandHome(trimmed) };
}

function parseCodexHomeEntry(value: unknown): CodexHomeSpec | undefined {
	if (typeof value === "string") return parseCodexHomeString(value);
	if (!isRecord(value)) return undefined;
	const homePath = readString(value.path) ?? readString(value.home) ?? readString(value.codexHome);
	if (!homePath) return undefined;
	return {
		name: readString(value.name) ?? readString(value.id),
		path: expandHome(homePath),
	};
}

function parseCodexHomeList(value: unknown): CodexHomeSpec[] {
	if (typeof value === "string") {
		return value
			.split(",")
			.map(parseCodexHomeString)
			.filter((spec): spec is CodexHomeSpec => spec !== undefined);
	}
	if (!Array.isArray(value)) return [];
	return value.map(parseCodexHomeEntry).filter((spec): spec is CodexHomeSpec => spec !== undefined);
}

function selectCodexHomeSpecs(
	options: ApplyCodexHomeAuthChainOptions,
	env: NodeJS.ProcessEnv,
): { specs: CodexHomeSpec[]; explicitEmpty: boolean } {
	if (options.codexHomeFlag !== undefined) {
		const spec = parseCodexHomeString(options.codexHomeFlag);
		return { specs: spec ? [spec] : [], explicitEmpty: spec === undefined };
	}
	const chainSpecs = parseCodexHomeList(options.codexHomeChainFlag);
	if (chainSpecs.length > 0) return { specs: chainSpecs, explicitEmpty: false };
	const configured = parseCodexHomeList(options.configuredHomes);
	if (configured.length > 0) return { specs: configured, explicitEmpty: false };
	const envHome = env[CODEX_HOME_ENV]?.trim();
	const envSpec = envHome ? parseCodexHomeString(envHome) : undefined;
	return { specs: envSpec ? [envSpec] : [], explicitEmpty: false };
}

function readCodexCredential(spec: CodexHomeSpec): CodexHomeCredential | undefined {
	const authPath = path.join(spec.path, "auth.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object" || !("tokens" in parsed)) return undefined;
	const tokens = parsed.tokens;
	if (!isRecord(tokens)) return undefined;
	const accessToken = readString(tokens.access_token);
	if (!accessToken) return undefined;
	return {
		...spec,
		authPath,
		accessToken,
		refreshToken: readString(tokens.refresh_token),
		accountId: readString(tokens.account_id),
		email: readString(tokens.email),
	};
}

export function applyCodexHomeAuth(
	codexHomeFlag: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): CodexHomeAuthResult {
	return applyCodexHomeAuthChain({ codexHomeFlag }, env);
}

export function applyCodexHomeAuthChain(
	options: ApplyCodexHomeAuthChainOptions,
	env: NodeJS.ProcessEnv = process.env,
): CodexHomeAuthResult {
	const { specs, explicitEmpty } = selectCodexHomeSpecs(options, env);
	if (options.codexHomeFlag !== undefined) {
		delete env[CODEX_HOME_ENV];
		if (explicitEmpty) {
			delete env[OPENAI_CODEX_OAUTH_TOKEN_ENV];
			return { applied: false, credentials: [], reason: "codex-home-unset" };
		}
	}
	if (specs.length === 0) return { applied: false, credentials: [], reason: "codex-home-unset" };

	const credentials = specs.map(readCodexCredential).filter((credential): credential is CodexHomeCredential => {
		return credential !== undefined;
	});
	if (credentials.length === 0) {
		const first = specs[0];
		const authPath = first ? path.join(first.path, "auth.json") : undefined;
		if (options.codexHomeFlag !== undefined) delete env[OPENAI_CODEX_OAUTH_TOKEN_ENV];
		return {
			applied: false,
			codexHome: first?.path,
			authPath,
			credentials: [],
			reason: authPath && fs.existsSync(authPath) ? "access-token-missing" : "auth-file-unreadable",
		};
	}

	const first = credentials[0];
	env[OPENAI_CODEX_OAUTH_TOKEN_ENV] = first.accessToken;
	return {
		applied: true,
		codexHome: first.path,
		authPath: first.authPath,
		accessToken: first.accessToken,
		credentials,
	};
}
