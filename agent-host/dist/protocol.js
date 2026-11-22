/**
 * Wire protocol v1: parent (DiceRealm .NET harness coordinator) <-> Node agent host.
 *
 * Contract source: docs/harness-agent-wire.md
 *
 * Transport: UTF-8 JSONL over stdin/stdout, one frame per line, every line bounded to
 * MAX_FRAME_BYTES. stdout carries protocol frames only; stderr carries safe codes only.
 */
/** Protocol revision this host speaks. */
export const PROTOCOL_VERSION = 1;
/** Runtime name reported in the one-time ready frame. */
export const RUNTIME_NAME = "pi";
/** Upstream Pi SDK version this host is pinned to and reports on startup. */
export const PI_VERSION = "0.87.1";
/** Maximum size of a single JSONL frame in either direction. */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
/** Virtual bridge provider id. Never a real paid provider. */
export const BRIDGE_PROVIDER_ID = "dicerealm-bridge";
/** Virtual bridge model id. Real model selection happens in the parent. */
export const BRIDGE_MODEL_ID = "host-model";
/** Display name of the bridge model. */
export const BRIDGE_MODEL_NAME = "DiceRealm Harness Bridge Model";
/** Historical output ceiling; new runs may delegate to provider defaults. */
export const MAX_MODEL_TOKENS = 4096;
/**
 * Fixed tool result text used when a `stop` result blocks the remaining tool calls of the
 * same assistant batch: those siblings must not reach the parent callback or execute.
 */
export const STOPPED_TOOL_BLOCK_TEXT = "Tool execution stopped for this turn; remaining tool calls in this batch were not executed.";
export class ProtocolError extends Error {
    code;
    constructor(code, message) {
        super(message ?? code);
        this.name = "ProtocolError";
        this.code = code;
    }
}
/** Stable error/termination codes emitted on stdout or stderr. */
export const ERROR_CODES = {
    invalidFrame: "invalid_frame",
    lineTooLarge: "line_too_large",
    unsupportedProtocol: "unsupported_protocol",
    invalidRun: "invalid_run",
    busy: "busy",
    unknownMessageType: "unknown_message_type",
    unknownReply: "unknown_reply",
    invalidReply: "invalid_reply",
    unsupportedMessageRole: "unsupported_message_role",
    limitModelCalls: "limit_model_calls",
    limitToolCalls: "limit_tool_calls",
    limitOutputCharacters: "limit_output_characters",
    limitContextBytes: "limit_context_bytes",
    limitTransportBytes: "limit_transport_bytes",
    modelReplyEmpty: "model_reply_empty",
    modelReplyUnknownTool: "model_reply_unknown_tool",
    systemPromptMismatch: "system_prompt_mismatch",
    toolDeclarationMismatch: "tool_declaration_mismatch",
    modelRequestFailed: "model_request_failed",
    toolRequestFailed: "tool_request_failed",
    cancelled: "cancelled",
    internalError: "internal_error",
};
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireString(value, field, allowEmpty = true) {
    if (typeof value !== "string") {
        throw new ProtocolError(ERROR_CODES.invalidRun, `${field} must be a string`);
    }
    if (!allowEmpty && value.length === 0) {
        throw new ProtocolError(ERROR_CODES.invalidRun, `${field} must not be empty`);
    }
    return value;
}
function requireCount(value, field) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new ProtocolError(ERROR_CODES.invalidRun, `${field} must be a non-negative integer`);
    }
    return value;
}
const TOOL_NAME = /^[A-Za-z0-9_]+$/;
function parseToolDescriptor(value, index) {
    if (!isRecord(value)) {
        throw new ProtocolError(ERROR_CODES.invalidRun, `tools[${index}] must be an object`);
    }
    const name = requireString(value.name, `tools[${index}].name`, false);
    if (!TOOL_NAME.test(name)) {
        throw new ProtocolError(ERROR_CODES.invalidRun, `tools[${index}].name must contain only ASCII letters, digits and underscore`);
    }
    const description = value.description === undefined ? "" : requireString(value.description, `tools[${index}].description`);
    const inputSchema = value.inputSchema === undefined ? { type: "object", properties: {} } : value.inputSchema;
    if (!isRecord(inputSchema)) {
        throw new ProtocolError(ERROR_CODES.invalidRun, `tools[${index}].inputSchema must be an object`);
    }
    return { name, description, inputSchema };
}
/** Validate one parsed `run` frame. Throws ProtocolError with a stable code. */
export function parseRunMessage(value) {
    if (typeof value.protocol !== "number") {
        throw new ProtocolError(ERROR_CODES.invalidRun, "run.protocol must be a number");
    }
    if (value.protocol !== PROTOCOL_VERSION) {
        throw new ProtocolError(ERROR_CODES.unsupportedProtocol, "unsupported protocol version");
    }
    const executionId = requireString(value.executionId, "run.executionId", false);
    const systemPrompt = requireString(value.systemPrompt, "run.systemPrompt");
    if (!Array.isArray(value.turns) || value.turns.length === 0) {
        throw new ProtocolError(ERROR_CODES.invalidRun, "run.turns must be a non-empty array of strings");
    }
    const turns = value.turns.map((turn) => requireString(turn, "run.turns[]"));
    if (!Array.isArray(value.tools)) {
        throw new ProtocolError(ERROR_CODES.invalidRun, "run.tools must be an array");
    }
    const tools = value.tools.map((tool, index) => parseToolDescriptor(tool, index));
    const seen = new Set();
    for (const tool of tools) {
        if (seen.has(tool.name)) {
            throw new ProtocolError(ERROR_CODES.invalidRun, `duplicate tool name: ${tool.name}`);
        }
        seen.add(tool.name);
    }
    if (!isRecord(value.limits)) {
        throw new ProtocolError(ERROR_CODES.invalidRun, "run.limits must be an object");
    }
    if (value.limits.providerDefaultOutput !== undefined && typeof value.limits.providerDefaultOutput !== "boolean") {
        throw new ProtocolError(ERROR_CODES.invalidRun, "invalid providerDefaultOutput");
    }
    const limits = {
        ...(value.limits.providerDefaultOutput === true ? { providerDefaultOutput: true } : {}),
        maxModelCalls: requireCount(value.limits.maxModelCalls, "run.limits.maxModelCalls"),
        maxToolCalls: requireCount(value.limits.maxToolCalls, "run.limits.maxToolCalls"),
        maxOutputCharacters: requireCount(value.limits.maxOutputCharacters, "run.limits.maxOutputCharacters"),
        maxContextBytes: requireCount(value.limits.maxContextBytes, "run.limits.maxContextBytes"),
    };
    if (value.contextPolicy !== undefined && value.contextPolicy !== "parent-compact-v1" && value.contextPolicy !== "parent-history-v2") {
        throw new ProtocolError(ERROR_CODES.invalidRun, "unsupported context policy");
    }
    return { type: "run", protocol: value.protocol, executionId, systemPrompt, turns, tools, limits,
        ...(value.contextPolicy === "parent-compact-v1" || value.contextPolicy === "parent-history-v2" ? { contextPolicy: value.contextPolicy } : {}) };
}
/** Validate one parsed reply frame. Error codes inside the frame are left to the caller. */
export function parseReplyFrame(value) {
    const executionId = requireString(value.executionId, "reply.executionId", false);
    const id = requireString(value.id, "reply.id", false);
    const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
    const hasError = Object.prototype.hasOwnProperty.call(value, "error");
    if (hasResult === hasError) {
        throw new ProtocolError(ERROR_CODES.invalidReply, "reply must carry exactly one of result or error");
    }
    return hasResult
        ? { type: "reply", executionId, id, result: value.result }
        : { type: "reply", executionId, id, error: value.error };
}
/** Extract the stable error code of a reply error, if it carries one. */
export function parseReplyErrorCode(value) {
    if (!isRecord(value)) {
        return ERROR_CODES.modelRequestFailed;
    }
    const code = value.code;
    return typeof code === "string" && code.length > 0 ? code : ERROR_CODES.modelRequestFailed;
}
/** Parse a raw JSONL line into a JSON value. Throws ProtocolError(invalid_frame). */
export function parseJsonLine(line) {
    try {
        return JSON.parse(line);
    }
    catch {
        throw new ProtocolError(ERROR_CODES.invalidFrame, "frame is not valid JSON");
    }
}
/** Best-effort extraction of an executionId from a raw frame, for error reporting. */
export function candidateExecutionId(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const executionId = value.executionId;
    return typeof executionId === "string" && executionId.length > 0 ? executionId : undefined;
}
/** Validate an already JSON-parsed value into an IncomingFrame. Throws ProtocolError. */
export function parseIncomingValue(parsed) {
    if (!isRecord(parsed)) {
        throw new ProtocolError(ERROR_CODES.invalidFrame, "frame must be a JSON object");
    }
    switch (parsed.type) {
        case "run":
            return parseRunMessage(parsed);
        case "reply":
            return parseReplyFrame(parsed);
        case "cancel": {
            const executionId = requireString(parsed.executionId, "cancel.executionId", false);
            return { type: "cancel", executionId };
        }
        case "shutdown":
            return { type: "shutdown" };
        default:
            throw new ProtocolError(ERROR_CODES.unknownMessageType, "unknown frame type");
    }
}
export function readyFrame() {
    return { type: "ready", protocol: PROTOCOL_VERSION, runtime: RUNTIME_NAME, version: PI_VERSION };
}
/** Stable id shape `<turn>:model:<sequence>` / `<turn>:tool:<sequence>`. */
export function requestId(kind, turn, sequence) {
    return `${turn}:${kind}:${sequence}`;
}
//# sourceMappingURL=protocol.js.map