import * as path from "node:path";

const ORDINARY_ENV_KEYS = new Set([
	"ALLUSERSPROFILE",
	"APPDATA",
	"COLORTERM",
	"COMMONPROGRAMFILES",
	"COMMONPROGRAMFILES(X86)",
	"COMMONPROGRAMW6432",
	"COMPUTERNAME",
	"COMSPEC",
	"HOME",
	"HOMEDRIVE",
	"HOMEPATH",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"LOCALAPPDATA",
	"LOGNAME",
	"NO_COLOR",
	"NUMBER_OF_PROCESSORS",
	"OMP_SESSION_ARTIFACT_DIR",
	"OMP_SESSION_CWD",
	"OMP_SESSION_ID",
	"OMP_IPYTHON_RUNTIME_PATH",
	"OS",
	"PATH",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"PROCESSOR_LEVEL",
	"PROCESSOR_REVISION",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"SHELL",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TMP",
	"TMPDIR",
	"TZ",
	"USER",
	"USERDOMAIN",
	"USERPROFILE",
	"USERNAME",
	"WINDIR",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"XDG_STATE_HOME",
]);

const SECRET_NAME =
	/API[_-]?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|OAUTH|BROKER/i;

function normalizedKey(key: string): string {
	return process.platform === "win32" ? key.toUpperCase() : key;
}

/** Positive environment passed to the private controller and its child kernel. */
export function ipythonEnvironment(
	source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		const normalized = normalizedKey(key);
		if (SECRET_NAME.test(normalized)) continue;
		if (!ORDINARY_ENV_KEYS.has(normalized) && !normalized.startsWith("LC_")) continue;
		environment[normalized === "PATH" ? "PATH" : key] = value;
	}
	environment.PYTHONDONTWRITEBYTECODE = "1";
	environment.PYTHONIOENCODING = "utf-8";
	environment.PYTHONNOUSERSITE = "1";
	environment.PYTHONUNBUFFERED = "1";
	environment.PYTHONUTF8 = "1";
	return environment;
}

/** Minimal host environment for uv; session identity and ambient credential settings are not inherited. */
export function ipythonBootstrapEnvironment(
	runtimeRoot: string,
	source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
	const environment = ipythonEnvironment(source);
	delete environment.OMP_SESSION_ARTIFACT_DIR;
	delete environment.OMP_SESSION_CWD;
	delete environment.OMP_SESSION_ID;
	delete environment.OMP_IPYTHON_RUNTIME_PATH;
	return {
		...environment,
		UV_CACHE_DIR: path.join(runtimeRoot, "uv-cache"),
		UV_DEFAULT_INDEX: "https://pypi.org/simple",
		UV_KEYRING_PROVIDER: "disabled",
		UV_NO_CONFIG: "1",
		UV_NO_PROGRESS: "1",
		UV_PYTHON_DOWNLOADS: "automatic",
		UV_PYTHON_INSTALL_DIR: path.join(runtimeRoot, "python"),
	};
}
