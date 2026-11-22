/**
 * Explicitly configured Pi SDK session for one harness run.
 *
 * Everything is supplied by the host: in-memory settings/session/credential store, an
 * empty resource loader with a single inline extension that forces the exact parent
 * system prompt, an MCP-served tool list, and the virtual bridge model. No built-in
 * coding tool, no global resource discovery, no provider network access.
 */
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { createMcpToolBridge } from "./mcp.js";
import { createBridgeModelRuntime } from "./model-bridge.js";
export class HostSession {
    #session;
    #mcp;
    #disposed = false;
    constructor(session, mcp) {
        this.#session = session;
        this.#mcp = mcp;
    }
    static async create(options) {
        const mcp = await createMcpToolBridge(options.tools, { onCall: options.onTool });
        try {
            const listed = await mcp.listTools();
            const rejectedToolCalls = new Set();
            const settingsManager = SettingsManager.inMemory({
                compaction: { enabled: false },
                retry: { enabled: false, maxRetries: 0, baseDelayMs: 0, provider: { maxRetries: 0 } },
                cacheWarming: "off",
            });
            const resourceLoader = new DefaultResourceLoader({
                cwd: options.cwd,
                agentDir: options.agentDir,
                settingsManager,
                noExtensions: true,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true,
                extensionFactories: [
                    {
                        name: "harness-exact-system-prompt",
                        hidden: true,
                        // Force the parent preset as the complete system prompt so Pi's own
                        // structured sections (cwd and friends) never reach the provider.
                        factory: (pi) => {
                            pi.on("before_agent_start", () => ({ systemPrompt: options.systemPrompt }));
                            // Pi ignores isError on execute's result; its tool_result hook owns
                            // the transcript error flag. Preserve content and stop independently.
                            pi.on("tool_result", (event) => {
                                if (rejectedToolCalls.delete(event.toolCallId))
                                    return { isError: true };
                            });
                        },
                    },
                ],
                systemPrompt: options.systemPrompt,
                appendSystemPrompt: [],
            });
            await resourceLoader.reload();
            const modelBridge = await createBridgeModelRuntime();
            const customTools = listed.map((descriptor) => ({
                name: descriptor.name,
                label: descriptor.name,
                description: descriptor.description,
                // Registered verbatim: the exact JSON Schema from the run frame is what Pi
                // validates against and what the model callback reports.
                parameters: descriptor.inputSchema,
                executionMode: "sequential",
                execute: async (toolCallId, params) => {
                    const reply = await mcp.callTool({
                        name: descriptor.name,
                        arguments: typeof params === "object" && params !== null && !Array.isArray(params)
                            ? params
                            : {},
                        toolCallId,
                    });
                    if (reply.isError)
                        rejectedToolCalls.add(toolCallId);
                    return {
                        content: [{ type: "text", text: reply.content }],
                        details: undefined,
                        terminate: reply.stop,
                    };
                },
            }));
            const { session } = await createAgentSession({
                cwd: options.cwd,
                model: modelBridge.model,
                thinkingLevel: "off",
                modelRuntime: modelBridge.modelRuntime,
                resourceLoader,
                // Allowlist exactly the bridge tools: this suppresses every built-in tool and
                // keeps the custom tools enabled.
                tools: listed.map((descriptor) => descriptor.name),
                customTools,
                sessionManager: SessionManager.inMemory(),
                settingsManager,
            });
            // One tool call at a time so a `stop` result can block its batch siblings before
            // they reach the parent callback.
            const surface = session;
            surface.agent.toolExecution = "sequential";
            if (options.toolGate) {
                const gate = options.toolGate;
                const original = surface.agent.beforeToolCall;
                surface.agent.beforeToolCall = async (context, signal) => {
                    const decision = await gate(context, signal);
                    if (decision) {
                        return decision;
                    }
                    return original ? original(context, signal) : undefined;
                };
            }
            if (options.shouldStop) {
                const shouldStop = options.shouldStop;
                const original = session.agent.finishTurn;
                session.agent.finishTurn = async (turn, signal) => {
                    // Preserve Pi boundary events. A prior non-stopping read means the SDK
                    // cannot end this mixed batch using per-tool `terminate` alone.
                    const decision = await original?.(turn, signal);
                    return shouldStop() ? { action: "end" } : decision ?? undefined;
                };
            }
            modelBridge.setResponder((context, model) => options.onModel(context, model));
            return new HostSession(session, mcp);
        }
        catch (error) {
            await mcp.close();
            throw error;
        }
    }
    /** Run one turn and wait for the SDK to fully settle (not merely `agent_end`). */
    async prompt(text) {
        await this.#session.prompt(text, { expandPromptTemplates: false });
        await this.#session.waitForIdle();
    }
    async abort() {
        await this.#session.abort();
    }
    lastAssistantText() {
        return this.#session.getLastAssistantText() ?? "";
    }
    /** Pi-native session entries, used as the private audit transcript. */
    transcriptEntries() {
        return this.#session.sessionManager.getEntries();
    }
    async dispose() {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        try {
            this.#session.dispose();
        }
        catch {
            // Session teardown must never mask the run result.
        }
        await this.#mcp.close();
    }
}
//# sourceMappingURL=host-session.js.map