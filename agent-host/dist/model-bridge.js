/**
 * Virtual bridge model runtime.
 *
 * The host never talks to a real provider: the upstream pi-ai faux provider is registered
 * as a native provider under a fixed non-secret bridge identity, and every model call is
 * answered by the parent-supplied responder. No model catalog network access, no global
 * resource discovery, no developer credentials are read.
 */
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BridgeError } from "./errors.js";
import { BRIDGE_MODEL_ID, BRIDGE_MODEL_NAME, BRIDGE_PROVIDER_ID, ERROR_CODES, } from "./protocol.js";
/** API id used by the virtual bridge provider's models. */
export const BRIDGE_PROVIDER_API = "dicerealm-bridge-api";
/** Model context window advertised by the virtual bridge model. */
const BRIDGE_CONTEXT_WINDOW = 128_000;
/** Model output ceiling; the request ceiling is min(MAX_MODEL_TOKENS, this). */
const BRIDGE_MODEL_MAX_TOKENS = 8192;
export function parseModelReply(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new BridgeError(ERROR_CODES.invalidReply);
    }
    const record = value;
    if (typeof record.text !== "string" || !Array.isArray(record.toolCalls)) {
        throw new BridgeError(ERROR_CODES.invalidReply);
    }
    const toolCalls = [];
    for (const entry of record.toolCalls) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            throw new BridgeError(ERROR_CODES.invalidReply);
        }
        const call = entry;
        if (typeof call.id !== "string" || typeof call.name !== "string") {
            throw new BridgeError(ERROR_CODES.invalidReply);
        }
        if (typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) {
            throw new BridgeError(ERROR_CODES.invalidReply);
        }
        toolCalls.push({ id: call.id, name: call.name, arguments: call.arguments });
    }
    const numberOrZero = (candidate) => (typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0);
    return {
        text: record.text,
        toolCalls,
        inputTokens: numberOrZero(record.inputTokens),
        outputTokens: numberOrZero(record.outputTokens),
    };
}
/**
 * Create the isolated model runtime + bridge model. The faux response queue is kept
 * non-empty by self-appending the single step factory, so one installed responder serves
 * every model call of the run.
 */
export async function createBridgeModelRuntime() {
    const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    const faux = fauxProvider({
        provider: BRIDGE_PROVIDER_ID,
        api: BRIDGE_PROVIDER_API,
        models: [
            {
                id: BRIDGE_MODEL_ID,
                name: BRIDGE_MODEL_NAME,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: BRIDGE_CONTEXT_WINDOW,
                maxTokens: BRIDGE_MODEL_MAX_TOKENS,
            },
        ],
    });
    const model = faux.getModel(BRIDGE_MODEL_ID);
    if (!model) {
        throw new BridgeError(ERROR_CODES.internalError);
    }
    let responder;
    const step = async (context, _options, _state, requestModel) => {
        faux.appendResponses([step]);
        if (!responder) {
            throw new BridgeError(ERROR_CODES.internalError);
        }
        return responder(context, requestModel);
    };
    faux.setResponses([step]);
    modelRuntime.registerNativeProvider(faux.provider);
    // registerNativeProvider kicks off an asynchronous availability refresh; wait briefly
    // so the snapshot is consistent before the first request resolves auth.
    const deadline = Date.now() + 5_000;
    while (!modelRuntime.getModel(BRIDGE_PROVIDER_ID, BRIDGE_MODEL_ID) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return {
        modelRuntime,
        model,
        setResponder(next) {
            responder = next;
        },
    };
}
//# sourceMappingURL=model-bridge.js.map