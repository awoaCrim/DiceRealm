using System.Text.Json;
using System.Text.Json.Nodes;

namespace DiceRealm.Server.Application;

internal static class HarnessEncounterTools
{
    private static JsonElement Schema(string json)
    { using var document = JsonDocument.Parse(json); return document.RootElement.Clone(); }
    internal static HarnessToolDescriptor WithMapScale(HarnessToolDescriptor tool)
    {
        var schema = JsonNode.Parse(tool.InputSchema.GetRawText())!.AsObject();
        schema["properties"]!.AsObject().Remove("grid");
        schema["required"] = new JsonArray(schema["required"]!.AsArray().Select(n => n!.GetValue<string>())
            .Where(name => name != "grid").Select(name => (JsonNode?)JsonValue.Create(name)).ToArray());
        return tool with
        {
            InputSchema = HarnessJson.Element(schema),
            Description = tool.Description.Replace("Retains the real image and every existing player position. grid is an explicit DM tactical scale, NOT recovered author geography; explain it in layoutReason.",
                "Uses ONLY the selected map's actual saved reliable scale and explicit tactical purpose. The server derives 5-foot logic cells without changing any physical length; there are NO pixel/grid arguments. Region, settlement, unknown-purpose or uncalibrated maps cannot be reinterpreted as 5 feet. Reuse a suitable current-scene local map with map_select; otherwise map_request purpose=tactical and wait for its one automatic lifecycle. After selecting a different map, explicitly place the SAME existing entities there with grounded new coordinates, retaining their old-map positions and HP/resources; never copy normalized positions. layoutReason explains the grounded placement/terrain, not a replacement scale.")
        };
    }
    internal static HarnessToolDescriptor WithoutPerceptionScale(HarnessToolDescriptor tool)
    {
        var schema = JsonNode.Parse(tool.InputSchema.GetRawText())!.AsObject();
        schema["properties"]!["encounterId"] = JsonNode.Parse("{\"type\":\"string\",\"minLength\":1,\"maxLength\":80}");
        return tool with
        {
            InputSchema = HarnessJson.Element(schema),
            Description = "Prepare ONE current-scene encounter from supplied non-model evidence and verified 2024 profiles. Initial call OMIT encounterId and use terrain=[]: save actual normalized enemy positions on the selected published map, individual names, sources and one server Stealth roll per hiding enemy. This preparation and any required Perception check work on BOTH calibrated and uncalibrated maps, regardless of purpose; never request/select/calibrate another map merely to roll perception. Hiding requires grounded three-quarters-cover or total-cover plus hidingReason explaining the scene cover and being out of sight; no fictitious grid or distances. No player token/initiative is needed for this initial observation setup. Use its saved encounterId, exact sourceId/quote and Wisdom/Perception without dc in check_request; active search waits for the actor. Keep all hidden data private. No reset or reroll. Only when actual combat needs a tactical layout, call this SAME tool with the existing encounterId and exact saved sourceId/quote: select a reliably calibrated tactical map, place all actual player tokens there, submit EVERY saved enemy in original order with unchanged name/rulesId/tactic and grounded new-map x/y, OMIT hidingCover/hidingReason, and supply explicit terrain cells. The server validates existing concealment against geometry, binds once and repositions the SAME enemy instances, retaining old-map placements, HP, state and personal discoveries; it never spawns or rolls again. Use returned names and entity IDs, never template labels or numbers. Preparation/binding never starts combat. Actual hostilities follow combat_delegate and own initiative consent. No model DC, self-reported stats, darkness/3D simulation or invented geography."
        };
    }
    public static HarnessToolDescriptor[] Extend(HarnessToolDescriptor[] previous) =>
    [
        .. previous.Select(tool =>
        {
            if (tool.Name != "check_request") return tool;
            var schema = JsonNode.Parse(tool.InputSchema.GetRawText())!;
            schema["properties"]!["encounterId"] = JsonNode.Parse("{\"type\":\"string\",\"maxLength\":80}");
            return tool with { InputSchema = HarnessJson.Element(schema), Description = "Request the current actor's real out-of-combat check; active checks await own consent, passive is only Wisdom/Perception. For concealed runtime enemies set encounterId from encounter_read/prepare, wisdom/Perception, and the setup's exact sourceId/quote; OMIT dc. Server compares the saved NPC Stealth results, records personal discoveries and never rerolls NPCs. Then encounter_read returns the private outcome. Otherwise dc must be explicitly in current source, or omit only for a genuinely useful unopposed number. No rerolls of this run's failed/cancelled task. This does not start combat or grant shared knowledge." };
        }),
        new("encounter_read", "Read current DM-only runtime encounter, actual roster/positions, saved NPC Hide dice, personal discoveries and verified 2024 profiles. Call to obtain available exact profiles before initial setup or to inspect a settled search. Never expose hidden roster/dice/positions in public text or memory. Read-only; does not initialize, roll, reveal or begin combat.", Schema("""
            {"type":"object","additionalProperties":false,"properties":{},"required":[]}
            """)),
        new("encounter_prepare", "Prepare ONE current-scene encounter from supplied non-model evidence and verified profile IDs. Does not start combat. Retains the real image and every existing player position. grid is an explicit DM tactical scale, NOT recovered author geography; explain it in layoutReason. terrain explicitly binds up to 35 grid cells; no terrain is inferred from art. Each enemy has a unique normalized position and supported tactic. Hiding requires three-quarters-cover or total-cover cells between it and all party members plus hidingReason confirming out-of-sight circumstances; server rolls its real DC15 Stealth once. Hidden instances/rolls stay private. No darkness/3D simulation, fake DC, self-reported stats, resets or cloning. Use the returned encounterId for a Perception check when relevant, then encounter_engage only if hostilities actually begin.", Schema("""
            {"type":"object","additionalProperties":false,"required":["mapId","sourceId","quote","layoutReason","grid","enemies","terrain"],"properties":{
              "mapId":{"type":"string","maxLength":36},"sourceId":{"type":"string","minLength":1,"maxLength":120},"quote":{"type":"string","minLength":1,"maxLength":800},"layoutReason":{"type":"string","minLength":1,"maxLength":500},
              "grid":{"type":"object","additionalProperties":false,"required":["cellPixels","offsetX","offsetY"],"properties":{"cellPixels":{"type":"number","exclusiveMinimum":0},"offsetX":{"type":"number"},"offsetY":{"type":"number"}}},
              "enemies":{"type":"array","minItems":1,"maxItems":6,"items":{"type":"object","additionalProperties":false,"required":["rulesId","name","tactic","x","y"],"properties":{"rulesId":{"type":"string","maxLength":80},"name":{"type":"string","minLength":1,"maxLength":80},"tactic":{"enum":["engage","ranged","withdraw"]},"x":{"type":"number","minimum":0,"maximum":1},"y":{"type":"number","minimum":0,"maximum":1},"hidingCover":{"enum":["","three-quarters-cover","total-cover"]},"hidingReason":{"type":"string","maxLength":500}}}},
              "terrain":{"type":"array","maxItems":35,"items":{"type":"object","additionalProperties":false,"required":["x","y","terrain"],"properties":{"x":{"type":"integer","minimum":0,"maximum":31},"y":{"type":"integer","minimum":0,"maximum":31},"terrain":{"enum":["blocked","difficult","half-cover","three-quarters-cover"]}}}}
            }}
            """)),
        new("encounter_engage", "Begin actual hostilities for the saved runtime encounter; reason is a private DM decision, not player consent. Server opens the existing per-player initiative consent group; no initiative/attack/damage before everyone confirms. surprisedActors lists only genuinely unaware party actors supported by still-hidden NPC records; discovered enemies preclude ambush surprise. 2024 surprise is initiative disadvantage, never a skipped round. NPC attacks and damage then use the existing persistent 2024 engine, including Shield/death waits. Do not use this for mere threats, a search alone or to bypass an unresolved ruling.", Schema("""
            {"type":"object","additionalProperties":false,"required":["encounterId","reason","surprisedActors"],"properties":{"encounterId":{"type":"string","maxLength":80},"reason":{"type":"string","minLength":1,"maxLength":500},"surprisedActors":{"type":"array","maxItems":6,"items":{"type":"string","maxLength":80}}}}
            """))
    ];
}
