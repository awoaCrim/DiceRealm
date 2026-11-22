using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class StoryTests
{
    private static async Task<CampaignSnapshot> Light(Host host)
    {
        var s = (await host.Create("World test")).Snapshot;
        Check.Equal(1, s.World!.Quests.Length); Check.Equal("active", s.World.Quests[0].Status);
        Check.True(!s.World.Npcs.Any(n => n.Id == "lian"));
        s = (await host.Act(s, "talk")).Snapshot; s = (await host.Act(s, "travel", "causeway")).Snapshot;
        s = (await host.Act(s, "travel", "beacon")).Snapshot; s = (await host.Act(s, "talk")).Snapshot;
        Check.Equal("completed", s.World!.Quests.Single(q => q.Id == "restore-beacon").Status);
        var asset = s.SceneAsset.Id; s = (await host.Act(s, "story.talk", "iven")).Snapshot;
        Check.Equal(asset, s.SceneAsset.Id); Check.True(s.World!.Npcs.Single(n => n.Id == "iven").Met);
        s = (await host.Act(s, "travel", "causeway")).Snapshot; return (await host.Act(s, "travel", "harbor")).Snapshot;
    }
    private static async Task<CampaignSnapshot> Accept(Host host, CampaignSnapshot s)
    {
        Check.Equal(HttpStatusCode.Conflict, (await host.Send(s.Id, new(Guid.NewGuid().ToString(), s.Version, "story.deliver", "guild"))).StatusCode);
        s = (await host.Act(s, "story.talk", "mara")).Snapshot;
        Check.Equal("available", s.World!.Quests.Single(q => q.Id == "tide-ledger").Status);
        s = (await host.Act(s, "story.accept", "tide-ledger")).Snapshot;
        Check.Equal("active", s.World!.Quests.Single(q => q.Id == "tide-ledger").Status);
        s = (await host.Act(s, "travel", "causeway")).Snapshot;
        Check.True(s.Map.Nodes.Single(n => n.Id == "watchpost").CanTravel);
        return (await host.Act(s, "travel", "watchpost")).Snapshot;
    }
    public static async Task FailedSearchAndWardens()
    {
        var dice = new SequenceDice(1); await using var host = await Host.Start(dice: dice);
        var s = await Accept(host, await Light(host));
        Check.True(s.AvailableActions.All(a => a.Kind != "investigate"), "New scene must not use old beacon handler");
        Check.True(s.Scene.Summary.Contains("货箱") && !s.Scene.Summary.Contains("本章任务已完成"));
        var failed = await host.Act(s, "story.search", "cargo-case"); s = failed.Snapshot;
        Check.True(!failed.Resolution.Check!.Success); Check.Equal(1, dice.Count);
        Check.True(!s.Character.Required().Inventory.Any(i => i.Id == "tide-ledger"));
        Check.Equal(HttpStatusCode.Conflict, (await host.Send(s.Id, new(Guid.NewGuid().ToString(), s.Version, "story.search", "cargo-case"))).StatusCode);
        Check.True(!s.World!.Npcs.Any(n => n.Id == "lian"));
        s = (await host.Act(s, "travel", "saltmarsh")).Snapshot;
        Check.True(s.World!.Quests.Any(q => q.Id == "stranded-crew"));
        s = (await host.Act(s, "story.talk", "lian")).Snapshot;
        s = (await host.Act(s, "story.recover", "tide-ledger")).Snapshot; Check.Equal(1, dice.Count);
        Check.Equal(1, s.Character.Required().Inventory.Single(i => i.Id == "tide-ledger").Quantity);
        s = (await host.Act(s, "story.rescue", "toma")).Snapshot;
        Check.Equal("harbor", s.World!.Npcs.Single(n => n.Id == "toma").SceneId);
        Check.True(s.World.Factions.All(f => f.Reputation == 1));
        s = (await host.Act(s, "story.deliver", "wardens")).Snapshot;
        Check.Equal(69, s.Character.Required().Inventory.Single(i => i.Id == "gold-piece").Quantity);
        Check.True(!s.Character.Inventory.Any(i => i.Id == "tide-ledger"));
        Check.Equal("wardens", s.World!.Branches.Single().Choice);
        Check.Equal(3, s.World.Factions.Single(f => f.Id == "reed-wardens").Reputation);
        Check.Equal(0, s.World.Factions.Single(f => f.Id == "harbor-guild").Reputation);
        Check.Equal("completed", s.World.Quests.Single(q => q.Id == "tide-ledger").Status);
        Check.True(s.Map.Nodes.Single(n => n.Id == "reed-sanctum").CanTravel);
        s = (await host.Act(s, "travel", "reed-sanctum")).Snapshot;
        var finish = new ActionRequest(Guid.NewGuid().ToString(), s.Version, "story.finish", "coast-pact");
        var once = (await (await host.Send(s.Id, finish)).Content.ReadFromJsonAsync<ActionResponse>())!;
        var twice = (await (await host.Send(s.Id, finish)).Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(twice.Replayed); Check.Equal(once.Snapshot.Version, twice.Snapshot.Version); s = twice.Snapshot;
        Check.Equal(4, s.Chapter); Check.Equal(1, s.Character.Required().Inventory.Count(i => i.Id == "coast-charter"));
        Check.True(s.World!.Quests.All(q => q.Status == "completed"));
        s = (await host.Act(s, "travel", "saltmarsh")).Snapshot; s = (await host.Act(s, "travel", "watchpost")).Snapshot;
        s = (await host.Act(s, "travel", "causeway")).Snapshot; s = (await host.Act(s, "travel", "harbor")).Snapshot;
        Check.Equal(HttpStatusCode.Conflict, (await host.Send(s.Id, new(Guid.NewGuid().ToString(), s.Version, "story.deliver", "guild"))).StatusCode);
        Check.True(!s.Map.Nodes.Any(n => n.Id == "guildhall")); Check.Equal(69, s.Character.Required().Inventory.Single(i => i.Id == "gold-piece").Quantity);
        Check.Equal(12, s.Character.HitPoints); Check.Equal(1, dice.Count);
    }
    public static async Task GuildBranchReplayAndRestart()
    {
        var dice = new SequenceDice(20); var host = await Host.Start(dice: dice);
        var s = await Accept(host, await Light(host));
        var found = await host.Act(s, "story.search", "cargo-case"); s = found.Snapshot;
        Check.True(found.Resolution.Check!.Success); Check.Equal(1, dice.Count);
        s = (await host.Act(s, "travel", "causeway")).Snapshot; s = (await host.Act(s, "travel", "harbor")).Snapshot;
        var delivery = new ActionRequest(Guid.NewGuid().ToString(), s.Version, "story.deliver", "guild");
        var results = await Task.WhenAll(host.Send(s.Id, delivery), host.Send(s.Id, delivery));
        var responses = await Task.WhenAll(results.Select(async r => (await r.Content.ReadFromJsonAsync<ActionResponse>())!));
        Check.True(responses[0].Replayed != responses[1].Replayed); s = responses[0].Snapshot;
        Check.Equal(69, s.Character.Required().Inventory.Single(i => i.Id == "gold-piece").Quantity);
        Check.Equal("guild", s.World!.Branches.Single().Choice); Check.Equal(2, s.World.Factions.Single().Reputation);
        Check.True(s.Map.Nodes.Single(n => n.Id == "guildhall").CanTravel);
        var before = JsonSerializer.Serialize(s.World); string root = host.Root;
        var token = host.Http.DefaultRequestHeaders.Authorization!.Parameter; await host.DisposeAsync();
        await using var restart = await Host.Start(root, dice);
        restart.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        s = (await restart.Get(s.Id))!; Check.Equal(before, JsonSerializer.Serialize(s.World));
        var replay = (await (await restart.Send(s.Id, delivery)).Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(replay.Replayed); Check.Equal(69, replay.Snapshot.Character.Required().Inventory.Single(i => i.Id == "gold-piece").Quantity);
        s = (await restart.Act(s, "travel", "guildhall")).Snapshot;
        s = (await restart.Act(s, "story.finish", "coast-pact")).Snapshot;
        Check.Equal(4, s.Chapter); Check.Equal("completed", s.World!.Quests.Single(q => q.Id == "coast-pact").Status);
        Check.True(!s.Map.Nodes.Any(n => n.Id == "reed-sanctum"));
    }
}
