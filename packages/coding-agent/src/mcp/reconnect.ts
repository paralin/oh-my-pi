/** Return whether an MCP transport failure can recover through one reconnect. */
export function isRetriableConnectionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	if (/^http (404|502|503):/.test(message)) return true;
	return [
		"econnrefused",
		"econnreset",
		"epipe",
		"enetunreach",
		"ehostunreach",
		"fetch failed",
		"transport not connected",
		"transport closed",
		"network error",
	].some(pattern => message.includes(pattern));
}
