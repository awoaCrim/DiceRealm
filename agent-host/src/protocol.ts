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
export const STOPPED_TOOL_BLOCK_TEXT =
	"Tool execution stopped for this turn; remaining tool calls in this batch were not executed.";

export class ProtocolError extends Error {
	readonly code: string;

	constructor(code: string, message?: string) {
		super(message ?? code);
		this.name = "ProtocolError";
		this.code = code;
	}
}

export interface ToolDescriptor {
	/** ASCII letters, digits and underscore only. */
	name: string;
	description: string;
	/** JSON Schema object handed to the parent as `inputSchema`. */
	inputSchema: Record<string, unknown>;
}

export interface RunLimits {
	/** New runs omit the provider output cap; absent preserves old replay payloads. */
	providerDefaultOutput?: boolean;
	/** Cumulative model round trips allowed for the whole run (all turns). */
	maxModelCalls: number;
	/** Cumulative tool round trips allowed for the whole run (all turns). */
	maxToolCalls: number;
	/** Cumulative characters of parent model reply text allowed for the whole run. */
	maxOutputCharacters: number;
	/** Maximum UTF-8 byte size of one serialized model request payload. */
	maxContextBytes: number;
}

export interface RunMessage {
	type: "run";
	protocol: number;
	executionId: string;
	systemPrompt: string;
	/** Original user inputs / continuations, replayed from turn 0 on every execution. */
	turns: string[];
	tools: ToolDescriptor[];
	limits: RunLimits;
	/** Only a new parent-owned contract may compact provider context; old transcripts stay exact. */
	contextPolicy?: "parent-compact-v1" | "parent-history-v2";
}

export interface ChatMessageUser {
	role: "user";
	content: string;
}

export interface ChatMessageAssistant {
	role: "assistant";
	content: string;
	toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

export interface ChatMessageTool {
	role: "tool";
	content: string;
	toolCallId: string;
	name: string;
	isError: boolean;
}

export type ChatMessage = ChatMessageUser | ChatMessageAssistant | ChatMessageTool;

export interface ModelRequestPayload {
	system: string;
	messages: ChatMessage[];
	tools: ToolDescriptor[];
	maxTokens: number;
}

export interface ToolRequestPayload {
	name: string;
	arguments: Record<string, unknown>;
	toolCallId: string;
}

export interface ModelReply {
	text: string;
	toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
	inputTokens: number;
	outputTokens: number;
}

export interface ToolReply {
	content: string;
	isError: boolean;
	stop: boolean;
}

export interface ReplyFrame {
	type: "reply";
	executionId: string;
	id: string;
	result?: unknown;
	error?: unknown;
}

export interface CancelFrame {
	type: "cancel";
	executionId: string;
}

export interface ShutdownFrame {
	type: "shutdown";
}

export interface ReadyFrame {
	type: "ready";
	protocol: number;
	runtime: string;
	version: string;
}

export interface RequestFrame {
	type: "request";
	executionId: string;
	id: string;
	kind: "model" | "tool";
	turn: number;
	sequence: number;
	payload: ModelRequestPayload | ToolRequestPayload;
}

export interface CompleteFrame {
	type: "complete";
	executionId: string;
	stopped: boolean;
	text: string;
	modelCalls: number;
	toolCalls: number;
	transcript: unknown[];
}

export interface ErrorFrame {
	type: "error";
	executionId?: string;
	code: string;
}

export type IncomingFrame = RunMessage | ReplyFrame | CancelFrame | ShutdownFrame;

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
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, allowEmpty = true): string {
	if (typeof value !== "string") {
		throw new ProtocolError(ERROR_CODES.invalidRun, `${field} must be a string`);
	}
	if (!allowEmpty && value.length === 0) {
		throw new ProtocolError(ERROR_CODES.invalidRun, `${field} must not be empty`);
	}
	return value;
}

function requireCount(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new ProtocolError(ERROR_CODES.invalidRun, `${field} must be a non-negative integer`);
	}
	return value;
}

const TOOL_NAME = /^[A-Za-z0-9_]+$/;

function parseToolDescriptor(value: unknown, index: number): ToolDescriptor {
	if (!isRecord(value)) {
		throw new ProtocolError(ERROR_CODES.invalidRun, `tools[${index}] must be an object`);
	}
	const name = requireString(value.name, `tools[${index}].name`, false);
	if (!TOOL_NAME.test(name)) {
		throw new ProtocolError(
			ERROR_CODES.invalidRun,
			`tools[${index}].name must contain only ASCII letters, digits and underscore`,
		);
	}
	const description = value.description === undefined ? "" : requireString(value.description, `tools[${index}].description`);
	const inputSchema = value.inputSchema === undefined ? { type: "object", properties: {} } : value.inputSchema;
	if (!isRecord(inputSchema)) {
		throw new ProtocolError(ERROR_CODES.invalidRun, `tools[${index}].inputSchema must be an object`);
	}
	return { name, description, inputSchema };
}

/** Validate one parsed `run` frame. Throws ProtocolError with a stable code. */
export function parseRunMessage(value: Record<string, unknown>): RunMessage {
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
	const seen = new Set<string>();
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
	const limits: RunLimits = {
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
export function parseReplyFrame(value: Record<string, unknown>): ReplyFrame {
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
export function parseReplyErrorCode(value: unknown): string {
	if (!isRecord(value)) {
		return ERROR_CODES.modelRequestFailed;
	}
	const code = value.code;
	return typeof code === "string" && code.length > 0 ? code : ERROR_CODES.modelRequestFailed;
}

/** Parse a raw JSONL line into a JSON value. Throws ProtocolError(invalid_frame). */
export function parseJsonLine(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		throw new ProtocolError(ERROR_CODES.invalidFrame, "frame is not valid JSON");
	}
}

/** Best-effort extraction of an executionId from a raw frame, for error reporting. */
export function candidateExecutionId(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const executionId = value.executionId;
	return typeof executionId === "string" && executionId.length > 0 ? executionId : undefined;
}

/** Validate an already JSON-parsed value into an IncomingFrame. Throws ProtocolError. */
export function parseIncomingValue(parsed: unknown): IncomingFrame {
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

export function readyFrame(): ReadyFrame {
	return { type: "ready", protocol: PROTOCOL_VERSION, runtime: RUNTIME_NAME, version: PI_VERSION };
}

/** Stable id shape `<turn>:model:<sequence>` / `<turn>:tool:<sequence>`. */
export function requestId(kind: "model" | "tool", turn: number, sequence: number): string {
	return `${turn}:${kind}:${sequence}`;
}
