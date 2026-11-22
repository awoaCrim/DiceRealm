/**
 * Normalized transcript projection for the parent model callback.
 *
 * The parent (authority) must see a stable, byte-reproducible transcript:
 * - read the final effective system prompt and tool declarations through the upstream
 *   pi-ai transcript helpers, never from a stale snapshot;
 * - drop runtime noise (timestamps, usage, cache, thinking) so rebuilding the same run
 *   produces the same request bytes;
 * - keep original text bytes and tool-call order.
 */
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { ERROR_CODES, ProtocolError } from "./protocol.js";
import { isRecord, stableJson } from "./util.js";
/** Flatten a message content field into stable plain text (thinking is not forwarded). */
function textOfContent(content) {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    const parts = [];
    for (const block of content) {
        if (!isRecord(block)) {
            continue;
        }
        if (block.type === "text" && typeof block.text === "string") {
            parts.push(block.text);
        }
        else if (block.type === "image" && typeof block.mimeType === "string") {
            parts.push(`[image:${block.mimeType}]`);
        }
    }
    return parts.join("\n");
}
/**
 * Convert the pi-ai Messages carried by the provider-facing transcript into the closed
 * ChatMessage set of the wire protocol. System messages are excluded: the effective
 * system prompt is sent separately in `payload.system`.
 */
export function normalizeMessages(messages) {
    const out = [];
    for (const message of messages) {
        switch (message.role) {
            case "system":
                continue;
            case "user":
                out.push({ role: "user", content: textOfContent(message.content) });
                break;
            case "assistant": {
                const toolCalls = [];
                for (const block of message.content ?? []) {
                    if (!isRecord(block) || block.type !== "toolCall") {
                        continue;
                    }
                    if (typeof block.id !== "string" || typeof block.name !== "string") {
                        continue;
                    }
                    toolCalls.push({
                        id: block.id,
                        name: block.name,
                        arguments: isRecord(block.arguments) ? block.arguments : {},
                    });
                }
                out.push({ role: "assistant", content: textOfContent(message.content), toolCalls });
                break;
            }
            case "toolResult":
                out.push({
                    role: "tool",
                    content: textOfContent(message.content),
                    toolCallId: message.toolCallId,
                    name: message.toolName,
                    isError: message.isError === true,
                });
                break;
            default:
                throw new ProtocolError(ERROR_CODES.unsupportedMessageRole, "transcript contains an unsupported message role");
        }
    }
    return out;
}
/** Effective system prompt the provider will receive for this request. */
export function effectiveSystemPrompt(context) {
    return getCurrentSystemPrompt(context.messages);
}
/** Effective tool declarations the provider will receive for this request. */
export function effectiveToolDescriptors(context) {
    return toToolDescriptors(getCurrentTools(context.messages));
}
export function toToolDescriptors(tools) {
    return tools.map((tool) => ({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        // `parameters` is the exact JSON Schema object handed in by the parent on the run frame.
        inputSchema: isRecord(tool.parameters) ? tool.parameters : { type: "object", properties: {} },
    }));
}
/** Order-sensitive equality of two descriptor lists (names and JSON Schema bytes). */
export function toolDescriptorsEqual(left, right) {
    if (left.length !== right.length) {
        return false;
    }
    return left.every((tool, index) => {
        const other = right[index];
        if (!other) {
            return false;
        }
        return (tool.name === other.name &&
            tool.description === other.description &&
            stableJson(tool.inputSchema) === stableJson(other.inputSchema));
    });
}
//# sourceMappingURL=transcript.js.map