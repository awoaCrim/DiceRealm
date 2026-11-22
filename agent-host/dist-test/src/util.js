/** Small shared helpers. */
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Canonical object keys; MCP may reorder schema properties without changing their meaning.
 * Array order and every scalar/text byte remain significant for deterministic replay. */
export function stableJson(value) {
    const canonical = (item) => {
        if (Array.isArray(item))
            return item.map(canonical);
        if (isRecord(item))
            return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
        return item;
    };
    return JSON.stringify(canonical(value ?? null));
}
export function utf8Bytes(value) {
    return Buffer.byteLength(value, "utf8");
}
//# sourceMappingURL=util.js.map