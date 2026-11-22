using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed record KnownSceneReference(string Id, string Title);
public sealed record AdventureContext(IntentContext Intent, WorldMemoryEntry[] KnownMemory, KnownSceneReference[] KnownScenes, bool CanNarrate);
public sealed record AdventureDecision(string Decision, string[] CandidateIds, string Question = "", string Narrative = "",
    WorldMemoryProposal[]? Memory = null, string Source = "ai");

public static class AdventureDirecting
{
    public static AdventureContext Build(Campaign c, IntentContext intent) => new(intent,
        WorldMemories.Read(c).Entries,
        Adventure.Map(c, Adventure.Choices(c)).Nodes.OrderByDescending(n => n.Id == c.SceneId).ThenByDescending(n => n.CanTravel).Take(64).Select(n => new KnownSceneReference(n.Id, IntentContexts.Bounded(n.Title, 100))).ToArray(),
        !CombatEngine.Restricted(c));

    public static AdventureDecision Validate(AdventureDecision value, AdventureContext context)
    {
        if (value is null || value.CandidateIds is null || value.Question is null || value.Narrative is null)
            throw new InvalidDataException("Invalid adventure response.");
        var memory = value.Memory ?? [];
        if (value.Decision == "narrate")
        {
            if (!context.CanNarrate || value.CandidateIds.Length != 0 || value.Question.Length != 0)
                throw new InvalidDataException("Narrative cannot replace an outstanding mechanical operation.");
            WorldMemories.Text(value.Narrative, 4096, multiline: true);
        }
        else
        {
            IntentContexts.Validate(new(value.Decision, value.CandidateIds, value.Question, value.Source), context.Intent);
            if (value.Narrative.Length != 0 || memory.Length != 0)
                throw new InvalidDataException("Unexecuted or mechanical choices cannot pre-apply narrative consequences.");
        }
        if (memory.Length > WorldMemories.MaximumProposals) throw new InvalidDataException("Too many world proposals.");
        return value with { Question = value.Question.Trim(), Narrative = value.Narrative.Trim(), Memory = memory,
            Source = value.Source is "offline" or "legacy" or "unavailable" ? value.Source : "ai" };
    }
}
