import assert from "node:assert/strict";
import { test } from "node:test";
import { stableJson } from "../src/util.js";
import { ERROR_CODES, MAX_FRAME_BYTES, PROTOCOL_VERSION, ProtocolError, candidateExecutionId, parseIncomingValue, parseJsonLine, parseReplyFrame, parseRunMessage, readyFrame, requestId, } from "../src/protocol.js";
function run(overrides = {}) {
    return {
        type: "run",
        protocol: 1,
        executionId: "exec-1",
        systemPrompt: "preset",
        turns: ["a"],
        tools: [{ name: "get_context", description: "d", inputSchema: { type: "object" } }],
        limits: { maxModelCalls: 1, maxToolCalls: 1, maxOutputCharacters: 1, maxContextBytes: 1 },
        ...overrides,
    };
}
test("canonical JSON ignores object key order, never array order or scalar values", () => {
    assert.equal(stableJson({ b: 2, a: { d: [], c: false } }), stableJson({ a: { c: false, d: [] }, b: 2 }));
    assert.notEqual(stableJson([1, 2]), stableJson([2, 1]));
    assert.notEqual(stableJson({ type: "string" }), stableJson({ type: "number" }));
});
test("ready frame reports protocol 1, pi runtime and pinned version", () => {
    const frame = readyFrame();
    assert.equal(frame.protocol, PROTOCOL_VERSION);
    assert.equal(frame.runtime, "pi");
    assert.equal(frame.version, "0.87.1");
    assert.equal(MAX_FRAME_BYTES, 2 * 1024 * 1024);
});
test("requestId keeps the documented slot shape", () => {
    assert.equal(requestId("model", 2, 3), "2:model:3");
    assert.equal(requestId("tool", 0, 0), "0:tool:0");
});
test("valid run frames parse into normalized descriptors", () => {
    const parsed = parseRunMessage(run({ tools: [{ name: "t_1" }] }));
    assert.equal(parsed.executionId, "exec-1");
    assert.deepEqual(parsed.tools, [{ name: "t_1", description: "", inputSchema: { type: "object", properties: {} } }]);
});
test("unsupported protocol version is rejected with a stable code", () => {
    assert.throws(() => parseRunMessage(run({ protocol: 2 })), (error) => error instanceof ProtocolError && error.code === ERROR_CODES.unsupportedProtocol);
});
test("invalid run shapes are rejected as invalid_run", () => {
    const cases = [
        run({ executionId: "" }),
        run({ turns: [] }),
        run({ turns: [1] }),
        run({ tools: [{ name: "bad-name" }] }),
        run({ tools: [{ name: "dup" }, { name: "dup" }] }),
        run({ limits: { maxModelCalls: -1, maxToolCalls: 1, maxOutputCharacters: 1, maxContextBytes: 1 } }),
        run({ limits: { maxModelCalls: 1.5, maxToolCalls: 1, maxOutputCharacters: 1, maxContextBytes: 1 } }),
        run({ limits: {} }),
        run({ tools: [{ name: "t", inputSchema: [] }] }),
    ];
    for (const value of cases) {
        assert.throws(() => parseRunMessage(value), (error) => error instanceof ProtocolError && error.code === ERROR_CODES.invalidRun, JSON.stringify(value));
    }
});
test("reply frames must carry exactly one of result or error", () => {
    const ok = parseReplyFrame({ type: "reply", executionId: "e", id: "0:model:0", result: { text: "" } });
    assert.deepEqual(ok.result, { text: "" });
    const failed = parseReplyFrame({ type: "reply", executionId: "e", id: "0:model:0", error: { code: "x" } });
    assert.deepEqual(failed.error, { code: "x" });
    const both = { type: "reply", executionId: "e", id: "i", result: {}, error: {} };
    assert.throws(() => parseReplyFrame(both), (error) => error instanceof ProtocolError && error.code === ERROR_CODES.invalidReply);
});
test("malformed JSON and unknown frame types have distinct codes", () => {
    assert.throws(() => parseJsonLine("{oops"), (error) => error instanceof ProtocolError && error.code === ERROR_CODES.invalidFrame);
    assert.throws(() => parseIncomingValue({ type: "nope" }), (error) => error instanceof ProtocolError && error.code === ERROR_CODES.unknownMessageType);
    assert.throws(() => parseIncomingValue("string"), (error) => error instanceof ProtocolError && error.code === ERROR_CODES.invalidFrame);
});
test("shutdown and cancel frames parse; cancel requires an executionId", () => {
    assert.deepEqual(parseIncomingValue({ type: "shutdown" }), { type: "shutdown" });
    assert.deepEqual(parseIncomingValue({ type: "cancel", executionId: "e" }), { type: "cancel", executionId: "e" });
    assert.throws(() => parseIncomingValue({ type: "cancel" }), (error) => error instanceof ProtocolError && error.code === ERROR_CODES.invalidRun);
});
test("candidateExecutionId only reports non-empty strings", () => {
    assert.equal(candidateExecutionId({ executionId: "a" }), "a");
    assert.equal(candidateExecutionId({ executionId: "" }), undefined);
    assert.equal(candidateExecutionId({ executionId: 7 }), undefined);
    assert.equal(candidateExecutionId("x"), undefined);
});
test("parent compaction is explicit and legacy frames remain unchanged", () => {
    assert.equal(Object.hasOwn(parseRunMessage(run()), "contextPolicy"), false);
    assert.equal(parseRunMessage(run({ contextPolicy: "parent-compact-v1" })).contextPolicy, "parent-compact-v1");
    assert.equal(parseRunMessage(run({ contextPolicy: "parent-history-v2" })).contextPolicy, "parent-history-v2");
    for (const policy of [null, true, "auto", "parent-compact-v2"]) {
        assert.throws(() => parseRunMessage(run({ contextPolicy: policy })), (error) => error instanceof ProtocolError && error.code === ERROR_CODES.invalidRun);
    }
});
//# sourceMappingURL=protocol.test.js.map