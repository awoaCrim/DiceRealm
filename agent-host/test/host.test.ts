/**
 * True-process integration tests: spawn `dist/main.js` and drive the real Pi SDK loop
 * through the JSONL wire protocol with parent-supplied model and tool replies.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ERROR_CODES, MAX_FRAME_BYTES, STOPPED_TOOL_BLOCK_TEXT } from "../src/protocol.js";
import {
	DEFAULT_LIMITS,
	DEFAULT_TOOLS,
	HostProcess,
	executeRun,
	makeRun,
} from "./support/host.js";

async function withHost<T>(fn: (host: HostProcess) => Promise<T>): Promise<T> {
	const host = new HostProcess();
	try {
		return await fn(host);
	} finally {
		await host.close();
	}
}

interface Message {
	role: string;
	content?: string;
	toolCallId?: string;
	isError?: boolean;
	toolCalls?: Array<{ id: string; name: string }>;
}

function payloads(host: HostProcess, kind: "model" | "tool"): Array<Record<string, unknown>> {
	return host
		.requests()
		.filter((frame) => frame.kind === kind)
		.map((frame) => frame.payload as Record<string, unknown>);
}

function ids(host: HostProcess): string[] {
	return host.requests().map((frame) => frame.id as string);
}

async function expectError(host: HostProcess, executionId: string): Promise<string> {
	const frame = await host.waitFor(
		(candidate) => candidate.type === "error" && (candidate.executionId === undefined || candidate.executionId === executionId),
	);
	return frame.code as string;
}

test("ready frame is emitted once, before any input", async () => {
	await withHost(async (host) => {
		const ready = await host.next();
		assert.deepEqual(ready, { type: "ready", protocol: 1, runtime: "pi", version: "0.87.1" });
		assert.equal(host.frames.filter((frame) => frame.type === "ready").length, 1);
	});
});

test("multi-step run: tool stop blocks its batch sibling and later turns still run", async () => {
	await withHost(async (host) => {
		const run = makeRun({ turns: ["turn-0", "turn-1"] });
		let modelCalls = 0;

		const complete = await executeRun(host, run, {
			onModel: () => {
				modelCalls += 1;
				if (modelCalls === 1) {
					return {
						result: {
							text: "planning",
							toolCalls: [
								{ id: "c1", name: "get_context", arguments: { scope: "party" } },
								{ id: "c2", name: "propose_action", arguments: { actionId: "a1" } },
							],
						},
					};
				}
				return { result: { text: "resumed", toolCalls: [] } };
			},
			onTool: (payload) => {
				assert.equal(payload.name, "get_context");
				return { result: { content: "awaiting consent", isError: false, stop: true } };
			},
		});

		// Exactly one tool travelled to the parent; the stopped batch sibling never did.
		assert.deepEqual(ids(host), ["0:model:0", "0:tool:0", "1:model:0"]);
		assert.deepEqual(payloads(host, "tool"), [
			{ name: "get_context", arguments: { scope: "party" }, toolCallId: "c1" },
		]);

		assert.equal(complete.type, "complete");
		assert.equal(complete.stopped, false);
		assert.equal(complete.text, "resumed");
		assert.equal(complete.modelCalls, 2);
		assert.equal(complete.toolCalls, 1);
		assert.ok(Array.isArray(complete.transcript) && complete.transcript.length > 0);

		// The blocked sibling is reported to the model with the fixed stopped text.
		const secondTurn = payloads(host, "model")[1] as { messages: Message[] };
		const blocked = secondTurn.messages.find((message) => message.role === "tool" && message.toolCallId === "c2");
		assert.ok(blocked, "blocked sibling tool result must be present");
		assert.equal(blocked.content, STOPPED_TOOL_BLOCK_TEXT);
		assert.equal(blocked.isError, true);
	});
});

test("a read before a stopping tool ends the batch without an extra model request", async () => {
	for (const resume of [false, true]) {
		await withHost(async (host) => {
			let calls = 0;
			const complete = await executeRun(host, makeRun({ turns: resume ? ["first", "next"] : ["first"] }), {
				onModel: () => ({ result: ++calls === 1 ? {
					text: "finished",
					toolCalls: [
						{ id: "read", name: "get_context", arguments: { scope: "scene" } },
						{ id: "stop", name: "propose_action", arguments: { actionId: "finish" } },
						{ id: "blocked", name: "get_context", arguments: { scope: "party" } },
					],
				} : { text: "resumed", toolCalls: [] } }),
				onTool: (payload) => ({ result: {
					content: payload.toolCallId === "read" ? "source evidence" : "saved",
					isError: false,
					stop: payload.toolCallId === "stop",
				} }),
			});
			assert.deepEqual(ids(host), ["0:model:0", "0:tool:0", "0:tool:1", ...(resume ? ["1:model:0"] : [])]);
			assert.equal(complete.type, "complete");
			assert.equal(complete.stopped, !resume);
			assert.equal(complete.text, resume ? "resumed" : "finished");
			assert.equal(complete.modelCalls, resume ? 2 : 1);
			assert.equal(complete.toolCalls, 2);
			if (resume) {
				const next = payloads(host, "model")[1] as { messages: Message[] };
				assert.deepEqual(next.messages.filter(m => m.role === "assistant").map(m => m.content), ["finished"]);
				assert.deepEqual(next.messages.filter(m => m.role === "tool").map(m => [m.toolCallId, m.content, m.isError]), [
					["read", "source evidence", false], ["stop", "saved", false], ["blocked", STOPPED_TOOL_BLOCK_TEXT, true],
				]);
			}
		});
	}
});

test("two different tools run back to back and both results return to the model", async () => {
	await withHost(async (host) => {
		let modelCalls = 0;
		const complete = await executeRun(host, makeRun(), {
			onModel: () => {
				modelCalls += 1;
				if (modelCalls === 1) {
					return {
						result: {
							text: "gather",
							toolCalls: [
								{ id: "c1", name: "get_context", arguments: { scope: "party" } },
								{ id: "c2", name: "propose_action", arguments: { actionId: "a1" } },
							],
						},
					};
				}
				return { result: { text: "both done", toolCalls: [] } };
			},
			onTool: (payload) => ({
				result: { content: `result:${String(payload.name)}`, isError: false, stop: false },
			}),
		});

		assert.deepEqual(ids(host), ["0:model:0", "0:tool:0", "0:tool:1", "0:model:1"]);
		assert.deepEqual(
			payloads(host, "tool").map((payload) => payload.name),
			["get_context", "propose_action"],
		);
		assert.equal(complete.type, "complete");
		assert.equal(complete.stopped, false);
		assert.equal(complete.text, "both done");
		assert.equal(complete.modelCalls, 2);
		assert.equal(complete.toolCalls, 2);

		const secondTurn = payloads(host, "model")[1] as { messages: Message[] };
		const toolMessages = secondTurn.messages.filter((message) => message.role === "tool");
		assert.deepEqual(
			toolMessages.map((message) => [message.toolCallId, message.content]),
			[
				["c1", "result:get_context"],
				["c2", "result:propose_action"],
			],
		);
	});
});

test("MCP error results preserve their text and error flag without forcing a stop", async () => {
	for (const stop of [false, true]) {
		await withHost(async (host) => {
			let modelCalls = 0;
			const content = JSON.stringify({ code: "invalid_world_memory", protocol: { applied: false } });
			const complete = await executeRun(host, makeRun(), {
				onModel: () => ({ result: ++modelCalls === 1
					? { text: "", toolCalls: [{ id: "rejected", name: "get_context", arguments: { scope: "party" } }] }
					: { text: "corrected", toolCalls: [] } }),
				onTool: () => ({ result: { content, isError: true, stop } }),
			});
			assert.equal(complete.stopped, stop);
			assert.equal(modelCalls, stop ? 1 : 2);
			if (!stop) {
				const next = payloads(host, "model")[1] as { messages: Message[] };
				const result = next.messages.find(m => m.role === "tool" && m.toolCallId === "rejected");
				assert.equal(result?.content, content);
				assert.equal(result?.isError, true);
			}
		});
	}
});

test("stop on the final turn settles with stopped=true and the pausing text", async () => {
	await withHost(async (host) => {
		const complete = await executeRun(host, makeRun(), {
			onModel: () => ({
				result: { text: "pausing", toolCalls: [{ id: "c1", name: "get_context", arguments: { scope: "scene" } }] },
			}),
			onTool: () => ({ result: { content: "waiting", isError: false, stop: true } }),
		});
		assert.equal(complete.type, "complete");
		assert.equal(complete.stopped, true);
		assert.equal(complete.text, "pausing");
		assert.equal(complete.modelCalls, 1);
		assert.equal(complete.toolCalls, 1);
	});
});

test("effective system prompt and tool schemas are byte-exact, and repeated runs replay identically", async () => {
	const preset = `预设原文 SYSTEM\n<cwd>C:/must/not/be/appended</cwd>\n"double" 'single' & <xml> \\ backslash\n第二行\ttab`;
	await withHost(async (host) => {
		const respond = (modelCalls: number) => {
			if (modelCalls === 1) {
				return {
					result: {
						text: "step one",
						toolCalls: [{ id: "c1", name: "get_context", arguments: { scope: "party" } }],
					},
				};
			}
			return { result: { text: "step two", toolCalls: [] } };
		};

		for (const executionId of ["replay-a", "replay-b"]) {
			let modelCalls = 0;
			const complete = await executeRun(
				host,
				makeRun({ executionId, systemPrompt: preset, turns: ["turn-0", "turn-1"] }),
				{
					onModel: () => {
						modelCalls += 1;
						return respond(modelCalls);
					},
					onTool: () => ({ result: { content: "context", isError: false, stop: false } }),
				},
			);
			assert.equal(complete.type, "complete");
		}

		const requests = host.requests().filter((frame) => frame.kind === "model");
		for (const frame of requests) {
			const payload = frame.payload as Record<string, unknown>;
			assert.equal(payload.system, preset, "system prompt must reach the model verbatim");
			assert.deepEqual(payload.tools, DEFAULT_TOOLS, "tool schemas must be exactly as supplied");
			assert.equal(payload.maxTokens, 4096);
			assert.ok(!JSON.stringify(payload).includes("timestamp"), "normalized transcript must not leak timestamps");
		}

		const runA = requests.filter((frame) => frame.executionId === "replay-a");
		const runB = requests.filter((frame) => frame.executionId === "replay-b");
		assert.equal(runA.length, 3);
		assert.equal(runB.length, 3);
		assert.deepEqual(
			runA.map((frame) => ({ id: frame.id, kind: frame.kind, payload: frame.payload })),
			runB.map((frame) => ({ id: frame.id, kind: frame.kind, payload: frame.payload })),
			"rebuilding the same run must produce identical request bytes",
		);
	});
});

test("MCP schema property reordering preserves exact values including empty required arrays", async () => {
	await withHost(async (host) => {
		const tools = [{ name: "context_read", description: "exact descriptor", inputSchema: {
			type: "object", additionalProperties: false, properties: {}, required: [],
		} }];
		const preset = "  原文前后空白\n不能丢失。\n";
		const complete = await executeRun(host, makeRun({ tools, systemPrompt: preset }), {
			onModel: (payload) => {
				assert.equal(payload.system, preset);
				assert.deepEqual(payload.tools, tools);
				return { result: { text: "done", toolCalls: [] } };
			},
		});
		assert.equal(complete.type, "complete");
	});
});

test("run-wide limits terminate with explicit, distinct codes", async () => {
	await withHost(async (host) => {
		// maxModelCalls is exceeded before any model request leaves the host.
		const modelLimit = makeRun({
			executionId: "lim-model",
			limits: { ...DEFAULT_LIMITS, maxModelCalls: 0 },
		});
		const modelLimitResult = await executeRun(host, modelLimit, {});
		assert.equal(modelLimitResult.code, ERROR_CODES.limitModelCalls);
		assert.equal(host.requests().filter((frame) => frame.executionId === "lim-model").length, 0);

		// maxToolCalls stops the tool callback even though the model asked for one.
		const toolLimit = makeRun({
			executionId: "lim-tool",
			limits: { ...DEFAULT_LIMITS, maxToolCalls: 0 },
		});
		const toolLimitResult = await executeRun(host, toolLimit, {
			onModel: () => ({
				result: { text: "call", toolCalls: [{ id: "c1", name: "get_context", arguments: { scope: "party" } }] },
			}),
			onTool: () => {
				throw new Error("tool callback must not run past the tool limit");
			},
		});
		assert.equal(toolLimitResult.code, ERROR_CODES.limitToolCalls);
		assert.equal(host.requests().filter((frame) => frame.kind === "tool").length, 0);

		const outputLimit = makeRun({
			executionId: "lim-output",
			limits: { ...DEFAULT_LIMITS, maxOutputCharacters: 3 },
		});
		const outputLimitResult = await executeRun(host, outputLimit, {
			onModel: () => ({ result: { text: "abcdef", toolCalls: [] } }),
		});
		assert.equal(outputLimitResult.code, ERROR_CODES.limitOutputCharacters);

		const contextLimit = makeRun({
			executionId: "lim-context",
			limits: { ...DEFAULT_LIMITS, maxContextBytes: 8 },
		});
		const contextLimitResult = await executeRun(host, contextLimit, {});
		assert.equal(contextLimitResult.code, ERROR_CODES.limitContextBytes);
		assert.equal(host.requests().filter((frame) => frame.executionId === "lim-context").length, 0);
	});
});

test("parent-declared model and tool failures propagate their codes", async () => {
	await withHost(async (host) => {
		const modelFailure = await executeRun(host, makeRun({ executionId: "fail-model" }), {
			onModel: () => ({ error: { code: "provider_unavailable" } }),
		});
		assert.equal(modelFailure.code, "provider_unavailable");

		const toolFailure = await executeRun(host, makeRun({ executionId: "fail-tool" }), {
			onModel: () => ({
				result: { text: "call", toolCalls: [{ id: "c1", name: "get_context", arguments: { scope: "party" } }] },
			}),
			onTool: () => ({ error: { code: "tool_denied" } }),
		});
		assert.equal(toolFailure.code, "tool_denied");
	});
});

test("malformed or empty model replies are rejected with distinct codes", async () => {
	await withHost(async (host) => {
		const empty = await executeRun(host, makeRun({ executionId: "empty" }), {
			onModel: () => ({ result: { text: "", toolCalls: [] } }),
		});
		assert.equal(empty.code, ERROR_CODES.modelReplyEmpty);

		const unknownTool = await executeRun(host, makeRun({ executionId: "unknown-tool" }), {
			onModel: () => ({ result: { text: "x", toolCalls: [{ id: "c1", name: "nope", arguments: {} }] } }),
		});
		assert.equal(unknownTool.code, ERROR_CODES.modelReplyUnknownTool);

		const malformed = await executeRun(host, makeRun({ executionId: "malformed" }), {
			onModel: () => ({ result: { text: 5 } }),
		});
		assert.equal(malformed.code, ERROR_CODES.invalidReply);
	});
});

test("cancel settles the run with a stable code and the process stays serialized", async () => {
	await withHost(async (host) => {
		host.send(makeRun({ executionId: "cancel-me" }));
		const request = await host.waitFor((frame) => frame.type === "request");
		assert.equal(request.id, "0:model:0");

		host.send({ type: "cancel", executionId: "cancel-me" });
		const cancelled = await host.waitFor((frame) => frame.type === "error");
		assert.equal(cancelled.executionId, "cancel-me");
		assert.equal(cancelled.code, ERROR_CODES.cancelled);

		// A later run is accepted after the cancelled one settles.
		const complete = await executeRun(host, makeRun({ executionId: "after-cancel" }), {
			onModel: () => ({ result: { text: "ok", toolCalls: [] } }),
		});
		assert.equal(complete.type, "complete");
		assert.equal(complete.text, "ok");
	});
});

test("a second concurrent run is rejected as busy", async () => {
	await withHost(async (host) => {
		host.send(makeRun({ executionId: "busy-a" }));
		await host.waitFor((frame) => frame.type === "request");

		host.send(makeRun({ executionId: "busy-b" }));
		const busy = await host.waitFor((frame) => frame.type === "error" && frame.executionId === "busy-b");
		assert.equal(busy.code, ERROR_CODES.busy);

		host.send({ type: "cancel", executionId: "busy-a" });
		await host.waitFor((frame) => frame.type === "error" && frame.executionId === "busy-a");
	});
});

test("invalid protocol frames report stable codes and do not kill the host", async () => {
	await withHost(async (host) => {
		host.send(makeRun({ executionId: "bad-protocol", protocol: 2 }));
		const unsupported = await host.waitFor((frame) => frame.type === "error");
		assert.equal(unsupported.code, ERROR_CODES.unsupportedProtocol);
		assert.equal(unsupported.executionId, "bad-protocol");

		host.writeRaw("{not json\n");
		const invalid = await host.waitFor((frame) => frame.type === "error");
		assert.equal(invalid.code, ERROR_CODES.invalidFrame);
		assert.equal(invalid.executionId, undefined);

		host.writeRaw(`${JSON.stringify({ type: "nonsense" })}\n`);
		const unknownType = await host.waitFor((frame) => frame.type === "error");
		assert.equal(unknownType.code, ERROR_CODES.unknownMessageType);

		// An unknown reply id while a run is active is a protocol violation.
		host.send(makeRun({ executionId: "unknown-reply" }));
		await host.waitFor((frame) => frame.type === "request" && frame.executionId === "unknown-reply");
		host.send({ type: "reply", executionId: "unknown-reply", id: "9:model:9", result: { text: "x", toolCalls: [] } });
		const stray = await host.waitFor((frame) => frame.type === "error" && frame.executionId === "unknown-reply");
		assert.equal(stray.code, ERROR_CODES.unknownReply);

		// Host is still usable.
		const complete = await executeRun(host, makeRun({ executionId: "still-alive" }), {
			onModel: () => ({ result: { text: "alive", toolCalls: [] } }),
		});
		assert.equal(complete.type, "complete");
	});
});

test("oversized stdin line is reported and the stream resynchronizes", async () => {
	await withHost(async (host) => {
		host.writeRaw(`${"a".repeat(MAX_FRAME_BYTES + 1)}\n`);
		const tooLarge = await host.waitFor((frame) => frame.type === "error");
		assert.equal(tooLarge.code, ERROR_CODES.lineTooLarge);

		const complete = await executeRun(host, makeRun({ executionId: "after-overflow" }), {
			onModel: () => ({ result: { text: "resynced", toolCalls: [] } }),
		});
		assert.equal(complete.type, "complete");
		assert.equal(complete.text, "resynced");
	});
});

test("stdin EOF tears the process down cleanly without leaving a dangling run", async () => {
	const host = new HostProcess();
	try {
		host.send(makeRun({ executionId: "eof-run" }));
		await host.waitFor((frame) => frame.type === "request");

		const code = await host.close();
		assert.equal(code, 0, "host must exit 0 on stdin EOF");
		assert.ok(!host.frames.some((frame) => frame.type === "complete" || frame.type === "error"));
		for (const line of host.stderrLines) {
			assert.match(line, /^agent-host: [a-z0-9_]+$/, "stderr must only carry safe codes");
		}
	} finally {
		await host.close();
	}
});


test("new provider-default output has no app token cap; legacy payload remains unchanged", async () => {
    await withHost(async (host) => {
        const result = await executeRun(host, makeRun({ limits: { ...DEFAULT_LIMITS, providerDefaultOutput: true } }), {
            onModel: () => ({ result: { text: "done", toolCalls: [] } }),
            onTool: () => ({ result: { content: "unused", isError: false, stop: false } }),
        });
        assert.equal(result.type, "complete");
        assert.equal(payloads(host, "model")[0]?.maxTokens, 0);
    });
});
