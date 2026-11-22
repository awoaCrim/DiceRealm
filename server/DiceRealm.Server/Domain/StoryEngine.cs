namespace DiceRealm.Server.Domain;

public sealed record QuestObjective(string Text, bool Complete);
public sealed record QuestView(string Id, string Title, string Status, string Summary, QuestObjective[] Objectives, string Reward);
public sealed record NpcView(string Id, string Name, string SceneId, string FactionId, bool Met, string Summary);
public sealed record FactionView(string Id, string Name, int Reputation, string Standing);
public sealed record BranchView(string Id, string Choice, string Label);
public sealed record WorldView(QuestView[] Quests, NpcView[] Npcs, FactionView[] Factions, BranchView[] Branches);

// Journal projection of the imported document; no authored story logic lives here.
public static class StoryEngine
{
    public static WorldView Snapshot(Campaign c) => ContentRuntime.World(c);
}
