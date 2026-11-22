/** Error wrapper carrying a stable, log-safe code (never carries upstream text upstream). */
export class BridgeError extends Error {
    code;
    constructor(code) {
        super(code);
        this.name = "BridgeError";
        this.code = code;
    }
}
//# sourceMappingURL=errors.js.map