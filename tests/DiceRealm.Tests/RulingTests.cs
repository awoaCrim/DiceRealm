using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class RulingTests
{
    public static Task Rules()
    {
        var dice = new SequenceDice(18, 3); var rules = new RulingEngine(new RulesEngine(dice));
        // Bounded DM checks run in the fixture's authored harbor scene.
        var c = TestContent.Campaign("harbor", "Rulings");
        c.Character = CharacterEngine.Create("Arden", CharacterEngine.Fighter);
        c.PartyMembers.Add(new() { Id = "guest", TokenHash = "g", Character = CharacterEngine.Create("Lyra", CharacterEngine.Wizard) });
        var id = Guid.NewGuid().ToString(); c.PendingRulings.Add(new(id, "检查不明魔法纹样", "pending", "unsupported", "guest", "harbor"));
        var req = new ResolveRulingRequest(Guid.NewGuid().ToString(), 1, id, "check", "本场鉴定纹样，只记录检定", "XPHB / Ability Checks; DC by DM", "intelligence", "Arcana", 12, "advantage");
        var before = JsonSerializer.Serialize(PartyEngine.Characters(c).ToArray());
        Check.Throws<GameException>(() => rules.Resolve(c, req with { Dc = 1 })); Check.Equal(0, dice.Count);
        Check.Throws<GameException>(() => rules.Resolve(c, req with { Ability = "strength" })); Check.Equal(0, dice.Count);
        c.ActingActorId = "guest"; Check.Throws<GameException>(() => rules.Resolve(c, req)); c.ActingActorId = "player";
        var result = rules.Resolve(c, req); Check.Equal(18, result.Check!.Selected); Check.Equal(4, result.Check.Modifier); Check.Equal(22, result.Check.Total);
        Check.Equal(before, JsonSerializer.Serialize(PartyEngine.Characters(c).ToArray())); Check.Equal(0, c.Facts.Count);
        var ruling = c.PendingRulings.Single(); Check.Equal("resolved", ruling.Status); Check.Equal("guest", ruling.ActorId); Check.Equal("player", ruling.ResolvedBy); Check.True(ruling.ResolvedAt is not null);
        Check.Throws<GameException>(() => rules.Resolve(c, req)); Check.Equal(2, dice.Count);
        c.PendingRulings.Add(new("battle", "施放 Shield", "pending", "unsupported", "guest", "harbor", "battle-1"));
        Check.Throws<GameException>(() => rules.Resolve(c, req with { RulingId = "battle" }));
        Check.Throws<GameException>(() => rules.Resolve(c, req with { RulingId = "battle", Outcome = "reject" })); // no hidden check parameters on reject
        var rejected = rules.Resolve(c, new(Guid.NewGuid().ToString(), 1, "battle", "reject", "反应窗口已过去，未消耗法术位", "本场裁定"));
        Check.True(rejected.Check is null); Check.Equal(2, dice.Count);
        return Task.CompletedTask;
    }
    public static async Task Http()
    {
        var dice = new SequenceDice(16); var h = await Host.Start(dice: dice);
        var owner = await h.Create(); var s = owner.Snapshot;
        s = (await h.Act(s, "natural", text: "检查一块没有规则选项的纹章")).Snapshot;
        var id = s.PendingRulings.Single().Id;
        var req = new ResolveRulingRequest(Guid.NewGuid().ToString(), s.Version, id, "check", "在原场景进行普通感知检定", "XPHB 2024 / Ability Checks; authored DC", "wisdom", "Perception", 12);
        var forged = new StringContent(JsonSerializer.Serialize(new { requestId = req.RequestId, expectedVersion = s.Version, rulingId = id, outcome = "check", rationale = "test", ruleSource = "test", hitPoints = 999 }), Encoding.UTF8, "application/json");
        Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsync($"/api/v1/campaigns/{s.Id}/rulings/resolve", forged)).StatusCode);
        var both = await Task.WhenAll(Enumerable.Range(0, 2).Select(_ => h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/rulings/resolve", req)));
        foreach (var response in both) Check.Equal(HttpStatusCode.OK, response.StatusCode);
        Check.Equal(1, dice.Count); var done = (await both[0].Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.Equal(19, done.Resolution.Check!.Total); Check.Equal("resolved", done.Snapshot.PendingRulings.Single().Status);
        Check.Equal(12, done.Snapshot.Character.Required().HitPoints); Check.Equal(0, done.Snapshot.Facts.Length);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/rulings/resolve", req with { Rationale = "changed" })).StatusCode);
        var root = h.Root; await h.DisposeAsync(); await using var restart = await Host.Start(root, dice);
        restart.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", owner.AccessToken);
        var replay = await restart.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/rulings/resolve", req);
        Check.Equal(HttpStatusCode.OK, replay.StatusCode); Check.True((await replay.Content.ReadFromJsonAsync<ActionResponse>())!.Replayed); Check.Equal(1, dice.Count);
        s = (await restart.Get(s.Id))!; s = (await restart.Act(s, "natural", text: "新的疑问")).Snapshot;
        var pending = s.PendingRulings.Last(); s = (await restart.Act(s, "talk")).Snapshot; s = (await restart.Act(s, "travel", "causeway")).Snapshot;
        Check.Equal(HttpStatusCode.Conflict, (await restart.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/rulings/resolve", req with { RequestId = Guid.NewGuid().ToString(), ExpectedVersion = s.Version, RulingId = pending.Id })).StatusCode);
        Check.Equal(1, dice.Count);
    }
}
