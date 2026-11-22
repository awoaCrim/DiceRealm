/**
 * One serialized harness run.
 *
 * Owns the parent callback bridge (model + tool), id/sequence accounting, run-wide
 * limits, the tool stop gate, and the single terminal frame. The parent remains the
 * authority for the model and every tool result; this class only drives the Pi loop.
 */

import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type AssistantMessage,
	type JsonObject,
	type Model,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { BridgeError } from "./errors.js";
import { HostSession, type HostSessionOptions, type ToolGateContext } from "./host-session.js";
import { parseModelReply } from "./model-bridge.js";
import type { McpToolCall } from "./mcp.js";
import {
	ERROR_CODES,
	MAX_FRAME_BYTES,
	MAX_MODEL_TOKENS,
	requestId,
	STOPPED_TOOL_BLOCK_TEXT,
	type ModelReply,
	type ModelRequestPayload,
	type ReplyFrame,
	type RunMessage,
	type ToolReply,
	type ToolRequestPayload,
} from "./protocol.js";
import {
	effectiveSystemPrompt,
	effectiveToolDescriptors,
	normalizeMessages,
	toolDescriptorsEqual,
} from "./transcript.js";
import { isRecord, utf8Bytes } from "./util.js";

export interface RunExecutionDeps {
	/** Emit one protocol frame on stdout (dropped after the channel closes). */
	send(frame: unknown): void;
	/** Emit one safe code on stderr. Never carries upstream text. */
	logSafe(code: string): void;
	/** Called exactly once when the run reaches a terminal state. */
	onSettled(executionId: string): void;
}

export interface RunExecutionOptions {
	/** Dedicated empty Pi agent dir; no global configuration is read. */
	agentDir: string;
}

interface PendingReply {
	resolve(frame: ReplyFrame): void;
	reject(error: Error): void;
}

/** Only letters, digits and underscore survive; anything else is replaced. */
export function sanitizeCode(code: string, fallback: string): string {
	return /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : fallback;
}

function parseToolReply(value: unknown): ToolReply {
	if (!isRecord(value) || typeof value.content !== "string" || typeof value.isError !== "boolean" || typeof value.stop !== "boolean") {
		throw new BridgeError(ERROR_CODES.invalidReply);
	}
	return { content: value.content, isError: value.isError, stop: value.stop };
}

export class RunExecution {
	readonly executionId: string;

	readonly #run: RunMessage;
	readonly #deps: RunExecutionDeps;
	readonly #agentDir: string;
	readonly #toolNames: Set<string>;

	#session: HostSession | null = null;
	#pending = new Map<string, PendingReply>();

	#modelCalls = 0;
	#toolCalls = 0;
	#outputCharacters = 0;

	#turn = 0;
	#modelSequence = 0;
	#toolSequence = 0;

	#stopGateToolCallId: string | null = null;
	#lastStopped = false;
	#lastText = "";

	#failureCode: string | null = null;
	#settled = false;

	constructor(run: RunMessage, deps: RunExecutionDeps, options: RunExecutionOptions) {
		this.#run = run;
		this.#deps = deps;
		this.#agentDir = options.agentDir;
		this.executionId = run.executionId;
		this.#toolNames = new Set(run.tools.map((tool) => tool.name));
	}

	get settled(): boolean {
		return this.#settled;
	}

	async start(): Promise<void> {
		let session: HostSession | null = null;
		try {
			if (this.#failureCode !== null) {
				this.#settleError(this.#failureCode);
				return;
			}

			const options: HostSessionOptions = {
				cwd: process.cwd(),
				agentDir: this.#agentDir,
				systemPrompt: this.#run.systemPrompt,
				tools: this.#run.tools,
				onModel: (context, model) => this.#onModel(context, model),
				onTool: (call) => this.#onTool(call),
				toolGate: (context) => this.#toolGate(context),
				shouldStop: () => this.#stopGateToolCallId !== null,
			};
			session = await HostSession.create(options);
			this.#session = session;

			if (this.#failureCode !== null) {
				this.#settleError(this.#failureCode);
				return;
			}

			for (let turn = 0; turn < this.#run.turns.length; turn += 1) {
				if (this.#failureCode !== null) {
					break;
				}
				this.#beginTurn(turn);
				await session.prompt(this.#run.turns[turn] ?? "");
				if (this.#failureCode !== null) {
					break;
				}
				this.#lastText = session.lastAssistantText();
				this.#lastStopped = this.#stopGateToolCallId !== null;
			}

			if (this.#failureCode !== null) {
				this.#settleError(this.#failureCode);
				return;
			}
			this.#settleComplete(session.transcriptEntries());
		} catch (error) {
			if (error instanceof BridgeError) {
				this.#settleError(sanitizeCode(error.code, ERROR_CODES.internalError));
			} else if (this.#failureCode !== null) {
				this.#settleError(this.#failureCode);
			} else {
				this.#deps.logSafe(ERROR_CODES.internalError);
				this.#settleError(ERROR_CODES.internalError);
			}
		} finally {
			this.#session = null;
			await session?.dispose();
		}
	}

	/** Best-effort immediate teardown for shutdown/EOF paths. */
	async dispose(): Promise<void> {
		const session = this.#session;
		this.#session = null;
		await session?.dispose();
	}

	/** Route a parent reply. Unknown ids are a protocol violation and terminate the run. */
	handleReply(frame: ReplyFrame): void {
		if (this.#settled || frame.executionId !== this.#run.executionId) {
			return;
		}
		const pending = this.#pending.get(frame.id);
		if (!pending) {
			this.cancel(ERROR_CODES.unknownReply);
			return;
		}
		this.#pending.delete(frame.id);
		pending.resolve(frame);
	}

	/**
	 * Abort the run with a stable code. Idempotent: the first code wins so a fatal limit
	 * is never overwritten by the abort it caused.
	 */
	cancel(code: string): void {
		if (this.#settled || this.#failureCode !== null) {
			return;
		}
		this.#failureCode = sanitizeCode(code, ERROR_CODES.internalError);
		this.#rejectPending(this.#failureCode);
		void this.#session?.abort().catch(() => {
			// Aborting a session that is already idle is not an error.
		});
	}

	#beginTurn(turn: number): void {
		this.#turn = turn;
		this.#modelSequence = 0;
		this.#toolSequence = 0;
		this.#stopGateToolCallId = null;
	}

	#fatal(code: string): BridgeError {
		this.cancel(code);
		return new BridgeError(this.#failureCode ?? code);
	}

	#rejectPending(code: string): void {
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const entry of pending) {
			entry.reject(new BridgeError(code));
		}
	}

	#request(kind: "model" | "tool", turn: number, sequence: number, payload: ModelRequestPayload | ToolRequestPayload): Promise<ReplyFrame> {
		const id = requestId(kind, turn, sequence);
		const failureCode = this.#failureCode;
		if (failureCode !== null) {
			return Promise.reject(new BridgeError(failureCode));
		}
		if (this.#pending.has(id)) {
			this.cancel(ERROR_CODES.internalError);
			return Promise.reject(new BridgeError(ERROR_CODES.internalError));
		}
		return new Promise<ReplyFrame>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#deps.send({
				type: "request",
				executionId: this.#run.executionId,
				id,
				kind,
				turn,
				sequence,
				payload,
			});
		});
	}

	async #onModel(context: TranscriptContext, model: Model<string>): Promise<AssistantMessage> {
		if (this.#failureCode !== null) {
			throw new BridgeError(this.#failureCode);
		}

		const turn = this.#turn;
		const sequence = this.#modelSequence;

		const system = effectiveSystemPrompt(context);
		if (system !== this.#run.systemPrompt) {
			throw this.#fatal(ERROR_CODES.systemPromptMismatch);
		}

		const effectiveTools = effectiveToolDescriptors(context);
		if (!toolDescriptorsEqual(effectiveTools, this.#run.tools)) {
			throw this.#fatal(ERROR_CODES.toolDeclarationMismatch);
		}

		if (this.#modelCalls >= this.#run.limits.maxModelCalls) {
			throw this.#fatal(ERROR_CODES.limitModelCalls);
		}

		const payload: ModelRequestPayload = {
			system,
			messages: normalizeMessages(context.messages),
			tools: effectiveTools,
			maxTokens: this.#run.limits.providerDefaultOutput ? 0 : Math.min(MAX_MODEL_TOKENS, model.maxTokens),
		};
		const contextBytes = utf8Bytes(JSON.stringify(payload));
		// The parent still enforces the provider budget. This opt-in only transports a
		// larger immutable transcript so it can derive a bounded new request; no Pi
		// automatic compaction or hidden model call is enabled.
		const callbackLimit = this.#run.contextPolicy !== undefined ? 1536 * 1024 : this.#run.limits.maxContextBytes;
		if (contextBytes > callbackLimit || contextBytes > MAX_FRAME_BYTES - 4096) {
			throw this.#fatal(this.#run.contextPolicy === "parent-history-v2"
				? ERROR_CODES.limitTransportBytes : ERROR_CODES.limitContextBytes);
		}

		this.#modelCalls += 1;
		this.#modelSequence += 1;
		this.#stopGateToolCallId = null;

		const frame = await this.#request("model", turn, sequence, payload);
		if (frame.error !== undefined) {
			throw this.#fatal(this.#parentErrorCode(frame.error, ERROR_CODES.modelRequestFailed));
		}

		let reply: ModelReply;
		try {
			reply = parseModelReply(frame.result);
		} catch {
			throw this.#fatal(ERROR_CODES.invalidReply);
		}

		if (reply.text.length === 0 && reply.toolCalls.length === 0) {
			throw this.#fatal(ERROR_CODES.modelReplyEmpty);
		}
		for (const call of reply.toolCalls) {
			if (!this.#toolNames.has(call.name)) {
				throw this.#fatal(ERROR_CODES.modelReplyUnknownTool);
			}
		}

		this.#outputCharacters += reply.text.length;
		if (this.#outputCharacters > this.#run.limits.maxOutputCharacters) {
			throw this.#fatal(ERROR_CODES.limitOutputCharacters);
		}

		const content = [];
		if (reply.text.length > 0) {
			content.push(fauxText(reply.text));
		}
		for (const call of reply.toolCalls) {
			content.push(fauxToolCall(call.name, call.arguments as JsonObject, { id: call.id }));
		}
		return fauxAssistantMessage(content, { stopReason: reply.toolCalls.length > 0 ? "toolUse" : "stop" });
	}

	async #onTool(call: McpToolCall): Promise<ToolReply> {
		if (this.#failureCode !== null) {
			throw new BridgeError(this.#failureCode);
		}
		if (this.#toolCalls >= this.#run.limits.maxToolCalls) {
			throw this.#fatal(ERROR_CODES.limitToolCalls);
		}

		const turn = this.#turn;
		const sequence = this.#toolSequence;
		this.#toolSequence += 1;
		this.#toolCalls += 1;

		const payload: ToolRequestPayload = {
			name: call.name,
			arguments: call.arguments,
			toolCallId: call.toolCallId,
		};

		const frame = await this.#request("tool", turn, sequence, payload);
		if (frame.error !== undefined) {
			throw this.#fatal(this.#parentErrorCode(frame.error, ERROR_CODES.toolRequestFailed));
		}

		let reply: ToolReply;
		try {
			reply = parseToolReply(frame.result);
		} catch {
			throw this.#fatal(ERROR_CODES.invalidReply);
		}

		if (reply.stop) {
			this.#stopGateToolCallId = call.toolCallId;
		}
		return reply;
	}

	/**
	 * Sibling tools of a batch whose earlier tool returned `stop` must not reach the parent
	 * callback or execute: block them with a fixed result that also terminates the batch.
	 */
	#toolGate(context: ToolGateContext): { block: true; reason: string; terminate: true } | undefined {
		if (this.#failureCode !== null) {
			return { block: true, reason: STOPPED_TOOL_BLOCK_TEXT, terminate: true };
		}
		if (this.#stopGateToolCallId !== null && context.toolCall.id !== this.#stopGateToolCallId) {
			return { block: true, reason: STOPPED_TOOL_BLOCK_TEXT, terminate: true };
		}
		return undefined;
	}

	#parentErrorCode(value: unknown, fallback: string): string {
		if (isRecord(value) && typeof value.code === "string") {
			return sanitizeCode(value.code, fallback);
		}
		return fallback;
	}

	#settleComplete(transcript: unknown[]): void {
		if (this.#settled) {
			return;
		}
		const frame = {
			type: "complete",
			executionId: this.#run.executionId,
			stopped: this.#lastStopped,
			text: this.#lastText,
			modelCalls: this.#modelCalls,
			toolCalls: this.#toolCalls,
			transcript,
		};
		if (utf8Bytes(JSON.stringify(frame)) > MAX_FRAME_BYTES) {
			this.#settleError(ERROR_CODES.lineTooLarge);
			return;
		}
		this.#settled = true;
		this.#deps.send(frame);
		this.#deps.onSettled(this.#run.executionId);
	}

	#settleError(code: string): void {
		if (this.#settled) {
			return;
		}
		this.#settled = true;
		this.#rejectPending(code);
		this.#deps.send({
			type: "error",
			executionId: this.#run.executionId,
			code: sanitizeCode(code, ERROR_CODES.internalError),
		});
		this.#deps.onSettled(this.#run.executionId);
	}
}
