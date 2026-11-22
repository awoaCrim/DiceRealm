/**
 * Standard MCP bridge: a real MCP `Client` and `Server` connected through an
 * `InMemoryTransport` linked pair. Tool listing and tool calls travel the MCP wire; the
 * server implementation delegates every call to the parent-supplied callback.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BridgeError } from "./errors.js";
import {
	ERROR_CODES,
	PI_VERSION,
	ProtocolError,
	type ToolDescriptor,
	type ToolReply,
} from "./protocol.js";
import { isRecord } from "./util.js";

export interface McpToolCall {
	name: string;
	arguments: Record<string, unknown>;
	/** Pi-provided tool call id; correlated to the parent callback and the stop gate. */
	toolCallId: string;
}

export interface McpToolHandler {
	onCall(call: McpToolCall): Promise<ToolReply>;
}

export interface McpToolBridge {
	/** Tool declarations as served by the MCP server (authoritative for the Pi tool set). */
	listTools(): Promise<ToolDescriptor[]>;
	callTool(call: McpToolCall): Promise<ToolReply>;
	close(): Promise<void>;
}

const TOOL_NAME = /^[A-Za-z0-9_]+$/;

function extractText(content: unknown): string {
	if (!Array.isArray(content)) {
		return "";
	}
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

export async function createMcpToolBridge(descriptors: ToolDescriptor[], handler: McpToolHandler): Promise<McpToolBridge> {
	/** Full parent replies recorded by the server handler, keyed by Pi tool call id. */
	const outcomes = new Map<string, ToolReply>();

	const server = new Server(
		{ name: "dicerealm-agent-host", version: PI_VERSION },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: descriptors.map((descriptor) => ({
			name: descriptor.name,
			description: descriptor.description,
			inputSchema: descriptor.inputSchema,
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const meta = request.params._meta as Record<string, unknown> | undefined;
		const toolCallId = typeof meta?.toolCallId === "string" ? meta.toolCallId : undefined;
		if (toolCallId === undefined) {
			throw new BridgeError(ERROR_CODES.internalError);
		}
		const call: McpToolCall = {
			name: request.params.name,
			arguments: isRecord(request.params.arguments) ? request.params.arguments : {},
			toolCallId,
		};
		const reply = await handler.onCall(call);
		outcomes.set(toolCallId, reply);
		return {
			content: [{ type: "text", text: reply.content }],
			isError: reply.isError,
		};
	});

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "dicerealm-agent-host", version: PI_VERSION }, { capabilities: {} });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

	let closed = false;

	return {
		async listTools(): Promise<ToolDescriptor[]> {
			const result = await client.listTools();
			return result.tools.map((tool) => {
				if (!TOOL_NAME.test(tool.name)) {
					throw new ProtocolError(ERROR_CODES.internalError, "MCP server exposed an invalid tool name");
				}
				return {
					name: tool.name,
					description: typeof tool.description === "string" ? tool.description : "",
					inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} },
				};
			});
		},

		async callTool(call: McpToolCall): Promise<ToolReply> {
			const result = await client.callTool({
				name: call.name,
				arguments: call.arguments,
				_meta: { toolCallId: call.toolCallId },
			}, undefined, call.name === "map_request" ? {
				// The parent owns cancellation and its <=1800s execution deadline. A tactical
				// map callback may await queued image work; MCP must not invent a 60s failure.
				timeout: 1_800_000,
			} : undefined);
			const outcome = outcomes.get(call.toolCallId);
			outcomes.delete(call.toolCallId);
			if (!outcome) {
				throw new BridgeError(ERROR_CODES.internalError);
			}
			return {
				// Return the text that actually travelled back over MCP, not the local value.
				content: extractText(result.content),
				isError: outcome.isError,
				stop: outcome.stop,
			};
		},

		async close(): Promise<void> {
			if (closed) {
				return;
			}
			closed = true;
			try {
				await client.close();
			} catch {
				// Closing an already-closed transport is not an error for this host.
			}
			try {
				await server.close();
			} catch {
				// See above.
			}
		},
	};
}
