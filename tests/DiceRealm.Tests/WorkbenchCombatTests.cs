using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;
using static DiceRealm.Tests.GameSaveTests;

namespace DiceRealm.Tests;

internal static class WorkbenchCombatTests
{
    internal static async Task<CreatedCampaign> CreateParty(Host h, bool hostOnly = true)
    {
        var document = StandardCombatTests.Document() with { StartSceneId = "harbor" };
        var response = await h.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("工作台战况验收", hostOnly ? "" : "Arden",
            Adventure: document, Prompts: TestContent.Prompts, StartImmediately: true, Build: hostOnly ? null : FullCreationTests.Named("Arden")));
        Check.True(response.StatusCode == HttpStatusCode.Created, await response.Content.ReadAsStringAsync());
        var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!; Auth(h, owner.AccessToken); return owner;
    }
    internal static async Task<CampaignSnapshot> Begin(Host h, CreatedCampaign player)
    {
        Auth(h, player.AccessToken); var s = (await h.Get(player.Snapshot.Id))!;
        s = (await h.Act(s, "talk")).Snapshot; s = (await h.Act(s, "travel", "causeway")).Snapshot;
        return (await h.Act(s, "combat.start")).Snapshot;
    }
    internal static async Task<CampaignSnapshot> Confirm(Host h, CreatedCampaign player)
    {
        Auth(h, player.AccessToken); var s = (await h.Get(player.Snapshot.Id))!;
        return (await Post<ActionResponse>(h, s.Id, "rolls/respond", new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll"))).Snapshot;
    }
    private static Task<string> State(Host h, CreatedCampaign owner) => h.App.Services.GetRequiredService<CampaignStore>()
        .Access(owner.Snapshot.Id, owner.AccessToken, false, c => Task.FromResult(JsonSerializer.Serialize(c, JsonFiles.Options)));
    private static async Task<JsonElement> Overview(Host h, CreatedCampaign owner)
    {
        Auth(h, owner.AccessToken); return await Get(h, owner.Snapshot.Id, "combat/overview");
    }
    private static JsonElement[] Waits(JsonElement view) => view.GetProperty("waits").EnumerateArray().ToArray();
    private static void SafeWait(JsonElement wait)
    {
        Check.Equal("actorId,actorName,description,id,kind,label,reason,state", string.Join(',', wait.EnumerateObject().Select(p => p.Name).Order()));
        Check.True(wait.EnumerateObject().All(p => p.Value.ValueKind == JsonValueKind.String));
    }
    public static async Task HostOnlyConsentAndTimeline()
    {
        var dice = new SequenceDice(20, 19, 1);
        var model = new Model((_, _) => throw new Exception("Overview must not call a model"));
        await using var h = await Host.Start(dice: dice, configure: Configure(model));
        var owner = await CreateParty(h); var first = await HarnessBoundaryTests.Guest(h, owner); var second = await HarnessBoundaryTests.Guest(h, owner);
        var empty = await Overview(h, owner); Check.Equal(JsonValueKind.Null, empty.GetProperty("combat").ValueKind); Check.Equal(0, Waits(empty).Length);
        var save = await Save(h, owner.Snapshot.Id, "开战前"); var entry = await Entry(h, owner.Snapshot.Id, save.GetProperty("saveId").GetString()!);
        await Begin(h, first);
        var pending = await Overview(h, owner); Check.Equal(2, Waits(pending).Length); Check.True(Waits(pending).All(w => w.GetProperty("state").GetString() == "pending"));
        Check.Equal(JsonValueKind.Null, pending.GetProperty("combat").ValueKind); Check.Equal(0, dice.Count);
        foreach (var row in Waits(pending)) SafeWait(row);
        var firstConfirmed = await Confirm(h, first); Check.True(firstConfirmed.PendingRoll is { Available: false });
        var confirmed = await Overview(h, owner); Check.Equal(1, Waits(confirmed).Count(w => w.GetProperty("state").GetString() == "confirmed"));
        Check.True((await h.Get(owner.Snapshot.Id))!.PendingRoll is null, "DM snapshot must not acquire another player's roll");
        Auth(h, second.AccessToken);
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.GetAsync(Url(owner.Snapshot.Id, "combat/overview"))).StatusCode);
        var battle = await Confirm(h, second); Check.Equal(3, dice.Count);
        var active = await Overview(h, owner); Check.Equal("active", active.GetProperty("combat").GetProperty("status").GetString());
        Check.Equal(0, Waits(active).Length); Check.Equal(3, active.GetProperty("combat").GetProperty("units").GetArrayLength());
        string before = await State(h, owner);
        for (int i = 0; i < 3; i++) await Overview(h, owner);
        Check.Equal(before, await State(h, owner)); Check.Equal(3, dice.Count); Check.Equal(0, model.Calls);
        var restored = await Load(h, owner.Snapshot.Id, entry); var after = await Overview(h, owner);
        Check.Equal(Branch(restored.GetProperty("snapshot")), after.GetProperty("timelineId").GetString());
        Check.True(after.GetProperty("timelineId").GetString() != active.GetProperty("timelineId").GetString());
        Check.Equal(JsonValueKind.Null, after.GetProperty("combat").ValueKind); Check.Equal(0, Waits(after).Length); Check.Equal(3, dice.Count);
        Check.True(battle.Combat!.TurnOrder.Length == 3);
    }
    public static async Task CompleteWaitingTextAndArchivedRead()
    {
        var dice = new SequenceDice(); var model = new Model((_, _) => throw new Exception("No model"));
        await using var h = await Host.Start(dice: dice, configure: Configure(model)); var owner = await CreateParty(h, false);
        string description = new string('等', 350) + "\n最终条件：DC 15，只能由本人确认。";
        await Mutate(h, owner, c =>
        {
            c.PendingRolls.Add(new() { Id = "long-roll", ActorId = PartyEngine.HostId, Label = "完整投掷说明", Description = description,
                Version = c.Version + 1, Intent = new("combat.start", "") });
            c.PendingIntents.Add(new() { Id = "private-intent", ActorId = PartyEngine.HostId, Text = "PRIVATE_ROOT_SENTINEL", PrivateRoot = true,
                Question = "要对哪一个目标行动？", Version = c.Version + 1, Options = [new("secret-option", "攻击", "combat", new("对手", "动作", "近战"), Action: new("combat.attack", "guardian"))] });
            c.Archived = true;
        });
        string before = await State(h, owner); var overview = await Overview(h, owner);
        Check.True(Waits(overview).All(w => w.GetProperty("state").GetString() == "blocked"));
        Check.Equal(description, Waits(overview).Single(w => w.GetProperty("id").GetString() == "long-roll").GetProperty("description").GetString());
        Check.Equal("", Waits(overview).Single(w => w.GetProperty("id").GetString() == "private-intent").GetProperty("label").GetString());
        Check.True(!overview.GetRawText().Contains("PRIVATE_ROOT_SENTINEL"));
        Check.Equal(before, await State(h, owner)); Check.Equal(0, dice.Count); Check.Equal(0, model.Calls);
    }
    public static async Task HiddenBattleUsesExistingVisibility()
    {
        var dice = new SequenceDice(15, 20, 19, 1); var model = new Model((_, _) => throw new Exception("No model"));
        await using var h = await Host.Start(dice: dice, configure: Configure(model));
        var owner = await CreateParty(h, false); var guest = await HarnessBoundaryTests.Guest(h, owner);
        var map = SharedBoardTests.Install(h, owner.Snapshot.Id, png: SharedBoardTests.MapPng(768, 512)) with { CurrentScene = true };
        await Mutate(h, owner, c =>
        {
            var spawns = PartyEngine.Characters(c).Select((p, i) => new BoardSpawn("", "creature", new("player", p.Id), new(p.Character.Name), 1.5 / 12, (i + 1.5) / 8, p.Id)).ToArray();
            SharedBoard.Execute(c, map, new(Id(), c.Version, map.Id, "spawn", Spawns: spawns, ExpectedMapVersion: map.Version), narrator: true, controlPlayers: true);
            var placements = new[] { new EncounterPlacement("xmm:goblin-warrior", "PRIVATE_HIDDEN_GUARD", "ranged", new(5.5 / 12, 2.5 / 8), "three-quarters-cover", "隔离伏兵在掩护后且处于视线外。") };
            var setup = RuntimeEncounters.Prepare(c, map, new() { Type = "square", CellPixels = 64 }, "伏兵交锋", c.SceneId, "隔离来源", "测试战术标尺", placements, [new(3, 2, "three-quarters-cover")]);
            setup = RuntimeEncounters.Establish(c, map, setup, placements, new RulesEngine(dice));
            c.RuntimeEncounters![0] = setup with { EngagementReason = "隔离实际交锋" };
            c.BoardMapContext = map; new CombatEngine(dice).Resolve(c, "combat.start", "");
        });
        string before = await State(h, owner); var host = await Overview(h, owner);
        Check.Equal(3, host.GetProperty("combat").GetProperty("units").GetArrayLength());
        Check.True(host.GetRawText().Contains("PRIVATE_HIDDEN_GUARD"));
        Auth(h, guest.AccessToken); var publicView = await Get(h, owner.Snapshot.Id);
        Check.Equal(2, publicView.GetProperty("combat").GetProperty("units").GetArrayLength());
        Check.True(!publicView.GetRawText().Contains("PRIVATE_HIDDEN_GUARD"));
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.GetAsync(Url(owner.Snapshot.Id, "combat/overview"))).StatusCode);
        Check.Equal(before, await State(h, owner)); Check.Equal(4, dice.Count); Check.Equal(0, model.Calls);
    }
    public static async Task StaleBlockedAndNarrowProjection()
    {
        var dice = new SequenceDice(); var model = new Model((_, _) => throw new Exception("No model"));
        await using var h = await Host.Start(dice: dice, configure: Configure(model));
        var owner = await CreateParty(h, false); var guest = await HarnessBoundaryTests.Guest(h, owner);
        await Begin(h, owner);
        await Mutate(h, owner, c =>
        {
            c.PendingRolls.Add(new() { Id = "removed-seat", ActorId = "missing-seat", Label = "must not appear", Description = "private", Version = c.Version + 1, Intent = new("combat.start", "") });
            c.PendingRolls.Add(new() { Id = "non-combat", ActorId = PartyEngine.HostId, Label = "not combat", Description = "private", Version = c.Version + 1, Intent = new("rest.hit_die", "") });
        });
        var stale = await Overview(h, owner); Check.Equal(2, Waits(stale).Length); Check.True(Waits(stale).All(w => w.GetProperty("state").GetString() == "stale"));
        await Mutate(h, owner, c =>
        {
            c.PendingRolls.RemoveAll(r => r.Id is "removed-seat" or "non-combat");
            foreach (var roll in c.PendingRolls) roll.Version = c.Version + 1;
            var member = c.PartyMembers.Single(); member.Character = member.Character with { HitPoints = 0, Conditions = ["Dead"] };
            c.PendingIntents.Add(new() { Id = "intent-combat", ActorId = PartyEngine.HostId, Text = "攻击对手", Question = "选择目标", Version = c.Version + 1,
                Options = [new("private-candidate", "攻击", "combat", new("对手", "动作", "近战"), Action: new("combat.attack", "PRIVATE_COMMAND"))] });
        });
        var blocked = await Overview(h, owner); Check.Equal(3, Waits(blocked).Length);
        Check.Equal("blocked", Waits(blocked).Single(w => w.GetProperty("actorId").GetString() == guest.Snapshot.Party!.SelfActorId).GetProperty("state").GetString());
        Check.True(Waits(blocked).Any(w => w.GetProperty("kind").GetString() == "intent"));
        foreach (var row in Waits(blocked)) SafeWait(row);
        Check.True(!blocked.GetRawText().Contains("PRIVATE_COMMAND") && !blocked.GetRawText().Contains("private-candidate"));
        string before = await State(h, owner); await Overview(h, owner); Check.Equal(before, await State(h, owner));
        Check.Equal(0, dice.Count); Check.Equal(0, model.Calls);
    }
}
