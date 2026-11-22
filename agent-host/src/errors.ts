/** Error wrapper carrying a stable, log-safe code (never carries upstream text upstream). */
export class BridgeError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = "BridgeError";
		this.code = code;
	}
}
