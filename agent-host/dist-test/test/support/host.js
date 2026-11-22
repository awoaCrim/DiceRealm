/**
 * Test parent: spawns the real built agent host (`dist/main.js`) as a child process and
 * speaks the JSONL wire protocol over its stdin/stdout. This exercises the true process
 * boundary (EOF, stderr discipline, frame bounds), not an in-process shortcut.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const ENTRY = process.env.DICEREALM_TEST_AGENT_HOST_PATH || join(PACKAGE_ROOT, "dist", "main.js");
/** Environment with credential-looking variables removed, mimicking parent scrubbing. */
export function scrubbedEnv() {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ANTHROPIC|OPENAI|GEMINI|GOOGLE|AWS|AZURE|COHERE|MISTRAL|_API|^PI_/i.test(key)) {
            continue;
        }
        env[key] = value;
    }
    return env;
}
export class HostProcess {
    child;
    frames = [];
    stderrLines = [];
    exitCode;
    #queue = [];
    #waiters = [];
    #buffer = "";
    #exited = false;
    #exitCode = null;
    constructor() {
        this.child = spawn(process.execPath, [ENTRY], {
            cwd: PACKAGE_ROOT,
            env: scrubbedEnv(),
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child.stdout.setEncoding("utf8");
        this.child.stdout.on("data", (chunk) => this.#ingest(chunk));
        this.child.stderr.setEncoding("utf8");
        this.child.stderr.on("data", (chunk) => {
            for (const line of chunk.split(/\r?\n/)) {
                if (line.length > 0) {
                    this.stderrLines.push(line);
                }
            }
        });
        this.exitCode = new Promise((resolve) => {
            this.child.on("exit", (code) => {
                this.#exited = true;
                this.#exitCode = code;
                for (const waiter of this.#waiters.splice(0)) {
                    waiter.reject(new Error("agent host exited"));
                }
                resolve(code);
            });
        });
    }
    #ingest(chunk) {
        this.#buffer += chunk;
        let newline = this.#buffer.indexOf("\n");
        while (newline !== -1) {
            const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
            this.#buffer = this.#buffer.slice(newline + 1);
            if (line.length > 0) {
                const frame = JSON.parse(line);
                this.frames.push(frame);
                const waiter = this.#waiters.shift();
                if (waiter) {
                    waiter.resolve(frame);
                }
                else {
                    this.#queue.push(frame);
                }
            }
            newline = this.#buffer.indexOf("\n");
        }
    }
    /** Next protocol frame, failing the test if the host exits first. */
    next(timeoutMs = 20_000) {
        const queued = this.#queue.shift();
        if (queued) {
            return Promise.resolve(queued);
        }
        if (this.#exited) {
            return Promise.reject(new Error(`agent host exited (${this.#exitCode})`));
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const index = this.#waiters.findIndex((waiter) => waiter.resolve === wrapped);
                if (index >= 0) {
                    this.#waiters.splice(index, 1);
                }
                reject(new Error("timed out waiting for a protocol frame"));
            }, timeoutMs);
            const wrapped = (frame) => {
                clearTimeout(timer);
                resolve(frame);
            };
            this.#waiters.push({ resolve: wrapped, reject });
        });
    }
    /** Next frame matching the predicate; earlier frames stay recorded in `frames`. */
    async waitFor(predicate, timeoutMs = 20_000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error("timed out waiting for matching frame");
            }
            const frame = await this.next(remaining);
            if (predicate(frame)) {
                return frame;
            }
        }
    }
    send(frame) {
        this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    }
    writeRaw(text) {
        this.child.stdin.write(text);
    }
    requests() {
        return this.frames.filter((frame) => frame.type === "request");
    }
    async endInput() {
        this.child.stdin.end();
    }
    /** Close stdin and wait for process exit, killing it if it does not exit in time. */
    async close(timeoutMs = 10_000) {
        if (!this.#exited) {
            this.child.stdin.end();
        }
        const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
        const result = await Promise.race([this.exitCode, timeout]);
        if (result === "timeout") {
            this.child.kill("SIGKILL");
            await this.exitCode;
        }
        return this.#exitCode;
    }
}
/** Drive one run to its terminal frame, answering callbacks with the supplied handlers. */
export async function executeRun(host, run, handlers) {
    const executionId = run.executionId;
    host.send(run);
    for (;;) {
        const frame = await host.next();
        if (frame.type === "complete") {
            return frame;
        }
        if (frame.type === "error" && frame.executionId === executionId) {
            return frame;
        }
        if (frame.type === "request") {
            const id = frame.id;
            const payload = frame.payload;
            let outcome;
            if (frame.kind === "model") {
                outcome = await handlers.onModel?.(payload, frame);
            }
            else {
                outcome = await handlers.onTool?.(payload, frame);
            }
            if (!outcome) {
                throw new Error(`no handler for request ${id}`);
            }
            host.send({ type: "reply", executionId, id, ...outcome });
        }
    }
}
export const DEFAULT_LIMITS = {
    maxModelCalls: 32,
    maxToolCalls: 32,
    maxOutputCharacters: 100_000,
    maxContextBytes: 262_144,
};
export const DEFAULT_TOOLS = [
    {
        name: "get_context",
        description: "Read the visible game context.",
        inputSchema: {
            type: "object",
            properties: { scope: { type: "string", enum: ["party", "scene"] } },
            required: ["scope"],
            additionalProperties: false,
        },
    },
    {
        name: "propose_action",
        description: "Propose a legal action.",
        inputSchema: {
            type: "object",
            properties: { actionId: { type: "string" } },
            required: ["actionId"],
            additionalProperties: false,
        },
    },
];
export function makeRun(overrides = {}) {
    return {
        type: "run",
        protocol: 1,
        executionId: "exec-1",
        systemPrompt: "You are the DiceRealm harness bridge.",
        turns: ["turn zero input"],
        tools: DEFAULT_TOOLS,
        limits: DEFAULT_LIMITS,
        ...overrides,
    };
}
//# sourceMappingURL=host.js.map