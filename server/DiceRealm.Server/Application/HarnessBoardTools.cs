using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

internal static class HarnessBoardTools
{
    private const string Point = "{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"x\",\"y\"],\"properties\":{\"x\":{\"type\":\"number\",\"minimum\":0,\"maximum\":1},\"y\":{\"type\":\"number\",\"minimum\":0,\"maximum\":1}}}";
    private const string Appearance = "{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"name\"],\"properties\":{\"name\":{\"type\":\"string\",\"minLength\":1,\"maxLength\":120},\"summary\":{\"type\":\"string\",\"maxLength\":2400},\"iconKey\":{\"type\":\"string\",\"maxLength\":100},\"visibility\":{\"const\":\"player\"}}}";
    private const string Source = "{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"kind\"],\"properties\":{\"kind\":{\"enum\":[\"existing\",\"player\",\"npc\",\"enemy\",\"custom\"]},\"id\":{\"type\":\"string\",\"maxLength\":160},\"encounterId\":{\"type\":\"string\",\"maxLength\":160}}}";
    private const string Map = "\"mapId\":{\"type\":\"string\",\"minLength\":36,\"maxLength\":36}";
    private const string Entity = "\"entityId\":{\"type\":\"string\",\"minLength\":36,\"maxLength\":36}";
    private static JsonElement Schema(string properties = "", string required = "")
    {
        using var document = JsonDocument.Parse("{\"type\":\"object\",\"additionalProperties\":false,\"properties\":{" + properties + "},\"required\":[" + required + "]}");
        return document.RootElement.Clone();
    }
    public static readonly HarnessToolDescriptor[] All =
    [
        new("map_state_read", "Read the current scene's published player board, exact spawn sources and latest operations. The parent automatically attaches same-version overview/detail images before every model call. No GM maps or hidden units. Viewing maps never changes sceneId; use offered travel/scene actions.", Schema()),
        new("token_read", "Read this current visible instance's actual details (unknown fields stay unknown), not a template or an action. Does not move, converse, spend resources or grant control.", Schema(Entity, "\"entityId\"")),
        new("token_spawn", "Place existing IDs or create up to 32 independent instances in ONE batch using exact supplied sources. NPC sources identify one existing person and are reused, enemy templates allow multiple distinct units. player binds only this run's actor and original Character, and player placements use the existing exact-intent confirmation (NPC-only batches execute directly); custom has no mechanics. Creating a token is NOT a summon, reward, item grant or payment. Reappearance retains state. Coordinates are map-normalized, origin top-left, right/down increase, token center; use all pending independent placements in one call before the next screenshot.",
            Schema(Map + ",\"spawns\":{\"type\":\"array\",\"minItems\":1,\"maxItems\":32,\"items\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"existingId\",\"kind\",\"source\",\"appearance\",\"x\",\"y\"],\"properties\":{\"existingId\":{\"type\":\"string\"},\"kind\":{\"enum\":[\"creature\",\"object\"]},\"source\":" + Source + ",\"appearance\":" + Appearance + ",\"x\":{\"type\":\"number\",\"minimum\":0,\"maximum\":1},\"y\":{\"type\":\"number\",\"minimum\":0,\"maximum\":1},\"actorId\":{\"type\":\"string\"}}}}", "\"mapId\",\"spawns\"")),
        new("token_move", "Move one authorized instance with optional explicit intermediate waypoints (no pathfinding). For the player's unit, act ONLY on the current player's expressed movement intent; the server freezes this exact command in the existing player confirmation flow before execution. Never invent a move, claim it completed before confirmation, or move another player's unit. Direct player drags remain immediate. Ordinary exploration saves placement without verifying walls/terrain/hazards. Battle movement uses the original turn/rule flow on the calibrated shared map; explicit waypoints must be legal adjacent grid steps, never inferred paths. Rule waits or known exploration restrictions are pending, not completed movement. Trust returned actual coordinates and notice. Coordinates: top-left origin, X right/Y down, 0..1, token center. Snap requires calibrated square grid.",
            Schema(Map + "," + Entity + ",\"destination\":" + Point + ",\"path\":{\"type\":\"array\",\"maxItems\":64,\"items\":" + Point + "},\"snap\":{\"type\":\"boolean\"}", "\"mapId\",\"entityId\",\"destination\"")),
        new("token_update", "Update only public name/description/icon on an authorized unit. Never HP, AC, abilities, conditions, inventory, resources or source/template bindings. Appearance has no rule effects; iconKey uses a registered local appearance: goblin, wolf, skeleton, zombie, spider, bear, boar, npc, chest (or empty fallback). Not a URL or secret identity; appearance never implies rules.",
            Schema(Map + "," + Entity + ",\"appearance\":" + Appearance, "\"mapId\",\"entityId\",\"appearance\"")),
        new("token_remove", "Take an authorized unit off this map, retaining its identity, current state and history. Not death, dismissal or deleting its character. Battle departures need the original rules flow.", Schema(Map + "," + Entity, "\"mapId\",\"entityId\""))
    ];
}
public sealed record HarnessTokenArgs(string EntityId);
public sealed record HarnessSpawnArgs(string MapId, BoardSpawn[] Spawns);
public sealed record HarnessMoveArgs(string MapId, string EntityId, BoardPoint Destination, BoardPoint[]? Path = null, bool Snap = false);
public sealed record HarnessUpdateArgs(string MapId, string EntityId, BoardAppearance Appearance);
public sealed record HarnessRemoveArgs(string MapId, string EntityId);
