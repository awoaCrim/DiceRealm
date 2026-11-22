using System.Text.Json.Nodes;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

// Only v23 provider presentation changes. Full self and native provider continuations stay
// in the persisted frame/journal; detail reads remain available with no new execution rights.
internal static class HarnessProviderContext
{
    public static HarnessChatMessage[] Messages(HarnessChatMessage[] messages, HarnessExecutionFrame frame)
    {
        // This is the parent-owned first-turn envelope, never arbitrary user prose or a
        // native assistant part. Preserve all later messages and provider continuations.
        if (messages.Length == 0 || messages[0].Role != "user" || frame.WorkingMemory is null && frame.History is null)
            throw HarnessJson.Conflict("harness_model_contract");
        JsonObject? initial;
        try { initial = JsonNode.Parse(messages[0].Content) as JsonObject; }
        catch (System.Text.Json.JsonException) { throw HarnessJson.Conflict("harness_model_contract"); }
        if (initial?.Count != 3 || initial["input"]?.GetValue<string>() != frame.Context.Intent.Text ||
            initial["ruleset"]?.GetValue<string>() != "dnd2024" || initial["memory"] is not JsonObject)
            throw HarnessJson.Conflict("harness_model_contract");
        if (frame.History is { } history)
        {
            initial["memory"] = JsonNode.Parse(HarnessProviderJson.Serialize(history));
            return [messages[0] with { Content = HarnessProviderJson.Serialize(initial) }, .. messages.Skip(1)];
        }
        var memory = JsonNode.Parse(HarnessJson.Serialize(frame.WorkingMemory))!.AsObject();
        // Stored history retains complete audit metadata. Provider-only zero/false
        // metadata can be omitted without dropping a source, quote or result.
        foreach (var entry in memory["entries"]!.AsArray().Concat(memory["archive"]?["selected"]?.AsArray() ?? []))
        {
            var row = entry!.AsObject();
            foreach (string key in new[] { "corrected", "recent" })
                if (row[key]?.GetValue<bool>() == false) row.Remove(key);
            foreach (string key in new[] { "totalContinuityEntries", "totalQuotedTexts", "totalSteps" })
                if (row[key]?.GetValue<int>() == 0) row.Remove(key);
            var texts = new[] { row["input"], row["narrative"] }.Concat(row["quotedText"]!.AsArray())
                .Concat(row["steps"]!.AsArray().Select(step => step!["summary"]));
            foreach (var value in texts.OfType<JsonObject>())
            {
                if (value["sourceOffset"]?.GetValue<int>() == 0) value.Remove("sourceOffset");
                if (value["truncated"]?.GetValue<bool>() == false) value.Remove("truncated");
            }
        }
        memory["notice"] = frame.WorkingMemory!.Notice + " Omitted flags=false; omitted counts/offsets=0.";
        initial["memory"] = memory;
        return [messages[0] with { Content = HarnessProviderJson.Serialize(initial) }, .. messages.Skip(1)];
    }

    public static JsonObject Frame(HarnessExecutionFrame frame, int toolContractVersion)
    {
        var json = JsonNode.Parse(HarnessJson.Serialize(frame))!.AsObject();
        json.Remove("workingMemory"); // supplied once in the initial server memory envelope
        json.Remove("history");
        if (toolContractVersion >= 45 && frame.History is { } history)
        {
            json.Remove("sharedStories"); // exact attributed bodies are in history
            if (frame.KnownInformation is { } known)
            {
                var supplied = history.Audiences.SelectMany(a => a.Summaries.SelectMany(s => s.Sources).Concat(a.Raw.Select(s => s.Source))).ToHashSet();
                var current = known.Entries.Where(e => e.SharedSequence is { } shared
                    ? !supplied.Any(s => s.Kind == "shared" && s.Id == shared.ToString(System.Globalization.CultureInfo.InvariantCulture))
                    : !supplied.Contains(new(e.Source.Kind, e.Source.Id, e.Source.Sequence,
                        e.Source.PartId is null ? "private" : "private:" + e.Source.PartId, e.Source.Revision))).ToArray();
                json["knownInformation"] = JsonNode.Parse(HarnessProviderJson.Serialize(new
                {
                    known.ActorId, entries = current,
                    notice = "Delivered knowledge not already represented in the source-addressed history envelope. Preserve its audience; current discoveries do not authorize another character to know them."
                }));
            }
        }
        if (json["board"]?["images"] is JsonArray images)
            foreach (var image in images.OfType<JsonObject>()) image.Remove("base64"); // actual multipart attachments, never text paths/base64
        if (frame.WorkingContext is { } working)
        {
            var supplied = working.PublicEvidence.Select(e => e.Id).ToHashSet(StringComparer.Ordinal);
            json["context"]!["knownMemory"] = JsonNode.Parse(HarnessJson.Serialize(frame.Context.KnownMemory.Where(e => !supplied.Contains(e.Id))));
        }
        if (frame.DetailedSelf != false || frame.Self is not { } self) return json;
        string input = frame.Context.Intent.Text;
        var spells = self.Spells.Where(s => input.Contains(s.Name, StringComparison.OrdinalIgnoreCase) ||
            input.Contains(s.Id, StringComparison.OrdinalIgnoreCase)).ToArray();
        var spellIds = spells.Select(s => s.Id).ToHashSet(StringComparer.Ordinal);
        json["self"] = JsonNode.Parse(HarnessJson.Serialize(new
        {
            self.ActorId, self.Id, self.Name, self.Species, self.ClassName, self.Background, self.Level, self.Classes,
            self.Identity, self.ArmorClass, self.HitPoints, self.MaxHitPoints, self.TemporaryHitPoints,
            self.Speed, self.Size, self.PassivePerception, self.Conditions, self.Exhaustion,
            self.Inventory, self.ActiveWeaponId, self.EquipmentStatus,
            resources = self.Resources.Select(r => new { r.Name, r.Current, r.Maximum }),
            skills = self.Skills.Where(s => s.Proficient || s.Expertise),
            relevantFeatures = self.Features.Where(f => input.Contains(f, StringComparison.OrdinalIgnoreCase)),
            relevantSpells = spells, relevantSpellRoutes = self.SpellRoutes.Where(s => spellIds.Contains(s.SpellId)),
            coverage = "Conversation projection; inventory and counters are current. Unlisted mechanics are omitted, not unavailable. context_read scope=character returns complete self; matching named spells/features are included here. " + (toolContractVersion >= 44
                ? "Use the available authoritative tools for mechanics: the AI DM may initiate check_request for narrative ability checks/saves beyond offered action candidates."
                : "Only offered actions execute mechanics.")
        }));
        return json;
    }
}
