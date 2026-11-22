/**
 * Agent host entry point.
 *
 * Reads bounded UTF-8 JSONL frames from stdin, drives one serialized Pi run at a time
 * through `RunExecution`, and writes protocol frames to stdout only. stderr carries safe
 * codes only. Exits on shutdown or stdin EOF and never leaves a dangling run.
 *
 * The Pi SDK barrel is heavy (~3 s to evaluate), so it is loaded through a dynamic import
 * that starts only after the ready frame is queued: the parent sees `ready` immediately.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_CODES, MAX_FRAME_BYTES, ProtocolError, candidateExecutionId, parseIncomingValue, parseJsonLine, readyFrame, } from "./protocol.js";
const SAFE_CODE = /^[a-z0-9_]{1,64}$/;
const CR = 0x0d;
const LF = 0x0a;
/** Splits a byte stream into newline-delimited frames, dropping oversized lines. */
class JsonlDecoder {
    #buffer = Buffer.alloc(0);
    #overflow = false;
    #onLine;
    #onOverflow;
    constructor(onLine, onOverflow) {
        this.#onLine = onLine;
        this.#onOverflow = onOverflow;
    }
    push(chunk) {
        let data = chunk;
        if (this.#overflow) {
            const newline = data.indexOf(LF);
            if (newline === -1) {
                return;
            }
            this.#overflow = false;
            data = data.subarray(newline + 1);
        }
        this.#buffer = this.#buffer.length === 0 ? data : Buffer.concat([this.#buffer, data]);
        let offset = 0;
        for (;;) {
            const newline = this.#buffer.indexOf(LF, offset);
            if (newline === -1) {
                break;
            }
            let line = this.#buffer.subarray(offset, newline);
            offset = newline + 1;
            if (line.length > 0 && line[line.length - 1] === CR) {
                line = line.subarray(0, line.length - 1);
            }
            if (line.length > MAX_FRAME_BYTES) {
                this.#onOverflow();
                continue;
            }
            if (line.length > 0) {
                this.#onLine(line.toString("utf8"));
            }
        }
        this.#buffer = this.#buffer.subarray(offset);
        if (this.#buffer.length > MAX_FRAME_BYTES) {
            this.#buffer = Buffer.alloc(0);
            this.#overflow = true;
            this.#onOverflow();
        }
    }
}
export async function runHost() {
    /** Dedicated empty agent dir next to the built package: no global Pi config is read. */
    const agentDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".agent-dir");
    let closed = false;
    let shuttingDown = false;
    let active = null;
    let writeChain = Promise.resolve();
    let lineChain = Promise.resolve();
    let runExecution = null;
    function loadRunExecution() {
        runExecution ??= import("./run-execution.js").then((module) => module.RunExecution);
        return runExecution;
    }
    function send(frame) {
        if (closed) {
            return;
        }
        const line = `${JSON.stringify(frame)}\n`;
        writeChain = writeChain.then(() => new Promise((resolve) => {
            process.stdout.write(line, () => resolve());
        }));
    }
    function logSafe(code) {
        if (SAFE_CODE.test(code)) {
            process.stderr.write(`agent-host: ${code}\n`);
        }
    }
    function startRun(run, Ctor) {
        const execution = new Ctor(run, {
            send,
            logSafe,
            onSettled: (executionId) => {
                if (active?.executionId === executionId) {
                    active = null;
                }
            },
        }, { agentDir });
        active = execution;
        void execution.start();
    }
    function dispatch(frame) {
        switch (frame.type) {
            case "reply":
                if (active !== null && active.executionId === frame.executionId) {
                    active.handleReply(frame);
                }
                return;
            case "cancel":
                if (active !== null && active.executionId === frame.executionId) {
                    active.cancel(ERROR_CODES.cancelled);
                }
                return;
            case "shutdown":
                void shutdown(0);
                return;
            case "run":
                // Handled by handleLine, which must load the Pi SDK first.
                return;
        }
    }
    async function handleLine(line) {
        let parsed;
        try {
            parsed = parseJsonLine(line);
        }
        catch (error) {
            send({ type: "error", code: error instanceof ProtocolError ? error.code : ERROR_CODES.invalidFrame });
            return;
        }
        try {
            const frame = parseIncomingValue(parsed);
            if (frame.type === "run") {
                const Ctor = await loadRunExecution();
                if (active !== null) {
                    send({ type: "error", executionId: frame.executionId, code: ERROR_CODES.busy });
                    return;
                }
                startRun(frame, Ctor);
                return;
            }
            dispatch(frame);
        }
        catch (error) {
            const code = error instanceof ProtocolError ? error.code : ERROR_CODES.invalidFrame;
            if (!(error instanceof ProtocolError)) {
                logSafe(ERROR_CODES.invalidFrame);
            }
            const executionId = candidateExecutionId(parsed);
            send(executionId === undefined ? { type: "error", code } : { type: "error", executionId, code });
        }
    }
    async function shutdown(exitCode) {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        closed = true;
        const running = active;
        active = null;
        running?.cancel(ERROR_CODES.cancelled);
        try {
            await running?.dispose();
        }
        catch {
            // Best-effort teardown on the way out.
        }
        try {
            await writeChain;
        }
        catch {
            // Nothing useful to report after shutdown started.
        }
        process.exit(exitCode);
    }
    const decoder = new JsonlDecoder((line) => {
        // Serialize line handling so run/cancel/busy decisions stay ordered even while
        // the first frame awaits the dynamic SDK import.
        lineChain = lineChain.then(() => handleLine(line));
    }, () => {
        send({ type: "error", code: ERROR_CODES.lineTooLarge });
    });
    process.stdin.on("data", (chunk) => {
        decoder.push(chunk);
    });
    process.stdin.on("end", () => {
        void shutdown(0);
    });
    process.stdin.on("close", () => {
        void shutdown(0);
    });
    process.stdin.on("error", () => {
        void shutdown(0);
    });
    process.on("SIGTERM", () => {
        void shutdown(0);
    });
    process.on("SIGINT", () => {
        void shutdown(0);
    });
    process.on("uncaughtException", () => {
        logSafe(ERROR_CODES.internalError);
        void shutdown(1);
    });
    process.on("unhandledRejection", () => {
        logSafe(ERROR_CODES.internalError);
    });
    process.stdin.resume();
    send(readyFrame());
    // Warm the Pi SDK load in the background right after the ready frame is queued.
    void loadRunExecution().catch(() => undefined);
}
void runHost();
//# sourceMappingURL=main.js.map