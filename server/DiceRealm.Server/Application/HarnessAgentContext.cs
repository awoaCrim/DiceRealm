using System.Text.Json.Nodes;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed record HarnessAgentContext(string Role, string? SessionId, string? EncounterId, CombatAgentHandoff? Handoff,
    CombatAgentPerson[]? People = null, int PeopleTotal = 0, int? HistoryAfter = null,
    string[]? RecentCombatSessions = null, int CompletedCombatSessions = 0,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] HarnessCombatAftermath? AfterCombat = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] bool? CombatPromptReady = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] HarnessCombatNarration? Narration = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] HarnessCombatCommand? Command = null);

public sealed record HarnessCombatCommand(CombatCommandSource Source, string Instruction);

public sealed record HarnessCombatNarration(bool Pending, bool CanContinue, HarnessCombatBeat[] Records);
public sealed record HarnessCombatBeat(int Sequence, string ActorId, string Kind, string Text, string Audience);

public sealed record HarnessCombatAftermath(string SessionId, string ReturnId, int Version, string Instruction);


internal static class HarnessAgentContexts
{
    internal const string AftermathInstruction = "战斗子代理的文字已经直接交付给玩家。当前是战后承接，不是再次响应开战前的攻击输入，也不是重写战报。只依据权威终态交代眼下处境、仍待决定的问题和下一步；不要重新描述攻击经过、补写伤害、追击或玩家选择。原输入只是被中断的历史意图，须结合后续选择重新判断是否仍成立。引用过去具体细节前用combat_history_read核对来源；有界摘录没有列出不代表不存在，也不允许凭空补全。本人发现仍只给本人，已结算的结果不重做。";

    internal static bool Allows(string tool, bool combat) => combat
        ? tool is "context_read" or "actions_list" or "actions_propose" or "checks_result" or "world_record" or "narrative_commit" or
            "combat_continue" or "combat_history_read" or "ctx_search" or "ctx_expand" or "story_shared_read" or "ask_player" or "ruling_request" or "rules_search" or "rules_read" or "rules_scope" or "dm_reference" or "map_state_read" or "token_read" or "encounter_read" or "encounter_engage"
        : tool is not ("encounter_engage" or "combat_continue");

    internal static HarnessToolDescriptor Present(HarnessToolDescriptor tool, bool combat, int contract = 36)
    {
        if (!combat) return tool;
        if (tool.Name == "context_read")
        {
            var schema = JsonNode.Parse(tool.InputSchema.GetRawText())!.AsObject();
            schema["properties"]!["scope"]!["enum"] = new JsonArray("context", "character");
            return tool with { InputSchema = HarnessJson.Element(schema), Description = "Read the current battle situation or this actor's full character. No exploration scene, routes, supplies or historical world retrieval. The current frame already supplies legal actions." };
        }
        if (tool.Name == "world_record")
        {
            var schema = JsonNode.Parse(tool.InputSchema.GetRawText())!.AsObject();
            foreach (string key in new[] { "memory", "items", "supplies" }) schema["properties"]![key]!["maxItems"] = 0;
            if (contract >= 43) return tool with
            {
                InputSchema = HarnessJson.Element(schema),
                Description = "Deliver established battle dialogue/story for this input. Public narrative may be empty. Optional privateMessages target the actual one or several recipientIds, independently of the actor; keep private experience/recognition with its knowers and public perceptible events public. No message or public hint when there is no addition. Undiscovered identities, host plans and future events go to no player. Each second-person message is STORY ONLY, with no dice/DC/result labels or receipts. Optional discoveryIds release only exactly those already-known entities for every recipient, never all pending findings; ordinary chat/retelling grants no location. Legacy nonempty private and messages cannot mix. Continuity stays public and attributed, not facts. No world memory, inventory or supplies writes. complete ends only this input, even when all text is empty, not the turn or battle. Actual mechanics/closure need authoritative receipts; no invented surrender or stopping combat in prose." + (contract >= 49 ? " Narrate only agent.narration.records: the current resolved unit action. The server prevents advancing another unit before this is saved and keeps this input running while an automatic continuation remains; then use combat_continue. PrivateMessages add ONLY recipient-exclusive NEW information; never retell a public action/result in second person. No new private information means []." : "") + (contract >= 53 ? " After a player movement beat, inputContinues=true requires reassessing the SAME input using refreshed candidates. The narration-only frame hid those candidates; it did not prove the entire request was complete. Continue only originally requested steps, preserve own dice consent, and do not repeat the saved beat. A single-step-only move must end without another move or attack." : "")
            };
            return tool with { InputSchema = HarnessJson.Element(schema), Description = "Deliver this input's public battle dialogue and narrative directly to the continuous activity stream. private stays with this actor and host; continuity is public attributed narration, not facts. No world memory, inventory or supplies writes. complete ends ONLY this input, not the turn or battle. Mechanics and battle closure require authoritative receipts. Negotiation stays in this session; do not invent surrender or stop combat in prose." + (contract >= 38 ? " Public narration uses third person; private uses second person only for this actor. Keep player-shared quotations attributed to their original actor." : "") + (contract >= 39 ? " private is STORY ONLY: no dice, totals, modifiers, DC, success/failure labels, waiting prompts or system receipts. Use established perceptible consequences; mechanics belong to the separate result UI." : "") };
        }
        return tool;
    }

    internal static bool Candidate(ActionCandidate candidate, bool combat) => combat
        ? candidate.Action?.Kind.StartsWith("combat.", StringComparison.Ordinal) == true || candidate.Character?.Operation is "equip" or "loadout" or "wear" or "execute"
        : candidate.Action?.Kind != "combat.start";
}
