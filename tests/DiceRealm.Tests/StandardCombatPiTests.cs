using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using Microsoft.Extensions.DependencyInjection;
using DiceRealm.Server.Infrastructure;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class StandardCombatPiTests
{
    public static async Task MissilePlanToOwnConsent()
    {
        var dice = new SequenceDice(20, 1, 1, 2, 3);
        var model = new Model((n, r) =>
        {
            if (n is 1 or 3 or 5) return Tool("context_read");
            if (n == 7) return Text("已按分配施放三枚飞弹，资源与伤害以保存的结果为准。");
            using var json = JsonDocument.Parse(r.Messages.Last(m => m.Name == "context_read").Content);
            var root = json.RootElement; var candidates = root.GetProperty("context").GetProperty("intent").GetProperty("candidates");
            string prefix = n switch { 2 => "Magic Missile / Test adventurer", 4 => "Magic Missile / 剩余全部 3枚至", 6 => "Magic Missile / 确认已分配飞弹", _ => throw new Exception("Unexpected model call") };
            var selected = candidates.EnumerateArray().First(x => x.GetProperty("label").GetString()!.StartsWith(prefix, StringComparison.Ordinal) &&
                (n != 4 || x.GetProperty("label").GetString()!.Contains("标准遭遇夹具")));
            Check.True(!root.GetRawText().Contains("sourceKey", StringComparison.OrdinalIgnoreCase) && !root.GetRawText().Contains("standardCombatFlow", StringComparison.OrdinalIgnoreCase));
            return Tool("actions_propose", new { candidateId = selected.GetProperty("id").GetString() });
        });
        var configure = Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var build = StandardSpellTests.Wizard(false).Build!;
            var created = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("飞弹Pi隔离", build.Identity.Name, StandardCombatTests.Document(), Preset, Build: build));
            Check.True(created.IsSuccessStatusCode); var owner = (await created.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken); string id = owner.Snapshot.Id; var s = owner.Snapshot;
            s = (await h.Act(s, "combat.start")).Snapshot;
            s = (await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll"))).Snapshot;
            var run = await Start(h, s, "三枚魔法飞弹全部命中前方敌人，不攻击同伴"); run = await Settled(h, id, run.Id, 3000);
            Check.Equal("waiting", run.Status); Check.Equal("roll", run.Wait!.Kind); Check.Equal(6, model.Calls); Check.Equal(2, dice.Count);
            s = (await h.Get(id))!; Check.Equal("missile-allocation", s.Combat!.Standard!.Wait!.Kind); Check.Equal(2, CharacterEngine.Value(s.Character.Required(), "Spell Slots (1st)"));
            var confirm = new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll"); string root = h.Root;
            await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure); h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var response = await Post<ActionResponse>(h, id, "rolls/respond", confirm); s = response.Snapshot;
            Check.Equal(5, dice.Count); Check.Equal(41, s.Combat!.Units.Single(u => u.Id == "guardian").HitPoints);
            run = await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), s.Version));
            run = await Settled(h, id, run.Id, 3000); Check.Equal("completed", run.Status); Check.Equal(7, model.Calls);
            await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure); h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var replay = await Post<ActionResponse>(h, id, "rolls/respond", confirm); Check.True(replay.Replayed);
            Check.Equal(HarnessJson.Serialize(response.Resolution), HarnessJson.Serialize(replay.Resolution)); Check.Equal(7, model.Calls); Check.Equal(5, dice.Count);
            Console.WriteLine("MISSILE actual Node/Pi/MCP: context -> no-cost plan -> exact all-target allocation -> own pending roll -> restart -> one payment/three darts -> resume -> restart receipt. 7 fake calls, 0 actual provider calls.");
        }
        finally { await h.DisposeAsync(); }
    }
    public static async Task PublicContextConsentAndRestart()
    {
        var dice = new SequenceDice(20, 1, 1);
        var model = new Model((n, r) =>
        {
            if (n == 1) return Tool("context_read");
            if (n == 2)
            {
                using var json = JsonDocument.Parse(r.Messages.Last(m => m.Name == "context_read").Content);
                var root = json.RootElement;
                // Current exploration agents receive action candidates, not the combat-agent board.
                Check.True(!root.TryGetProperty("combat", out _));
                Check.True(!root.GetRawText().Contains("standardCombatFlow", StringComparison.OrdinalIgnoreCase));
                string selected = root.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                    .Single(x => x.GetProperty("label").GetString()!.StartsWith("借机攻击 /", StringComparison.Ordinal)).GetProperty("id").GetString()!;
                return Tool("actions_propose", new { candidateId = selected });
            }
            if (n == 3) return Text("借机攻击已经结算，敌人继续撤离，没有重复攻击。");
            throw new Exception("Unexpected model call " + n);
        });
        var configure = Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(h, StandardCombatTests.Document("withdraw")); var s = owner.Snapshot; string id = s.Id;
            s = (await h.Act(s, "combat.start")).Snapshot;
            s = (await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll"))).Snapshot;
            s = (await h.Act(s, "combat.end_turn")).Snapshot; Check.Equal(2, dice.Count);
            var old = await h.App.Services.GetRequiredService<GameService>().HarnessTool(id, owner.AccessToken, "player", Id(), "进行借机攻击", s.Version, Id(), "old-read",
                new("context_read", HarnessJson.Element(new { }), Id()), [], CancellationToken.None, new(Preset, HarnessJson.ProfileHash(Preset, []), []), toolContractVersion: 8);
            using (var json = JsonDocument.Parse(old.Reply.Content))
            {
                Check.True(!json.RootElement.TryGetProperty("combat", out _));
                Check.Equal(0, json.RootElement.GetProperty("context").GetProperty("intent").GetProperty("candidates").GetArrayLength());
            }
            var v9 = await h.App.Services.GetRequiredService<GameService>().HarnessTool(id, owner.AccessToken, "player", Id(), "进行借机攻击", s.Version, Id(), "frozen-v9-read",
                new("context_read", HarnessJson.Element(new { }), Id()), [], CancellationToken.None, new(Preset, HarnessJson.ProfileHash(Preset, []), []), toolContractVersion: 9);
            using (var json = JsonDocument.Parse(v9.Reply.Content)) Check.True(!json.RootElement.GetProperty("combat").TryGetProperty("masteries", out _));
            var v10 = await h.App.Services.GetRequiredService<GameService>().HarnessTool(id, owner.AccessToken, "player", Id(), "进行借机攻击", s.Version, Id(), "frozen-v10-read",
                new("context_read", HarnessJson.Element(new { }), Id()), [], CancellationToken.None, new(Preset, HarnessJson.ProfileHash(Preset, []), []), toolContractVersion: 10);
            using (var json = JsonDocument.Parse(v10.Reply.Content))
            {
                var board = json.RootElement.GetProperty("combat");
                Check.Equal("opportunity", board.GetProperty("wait").GetProperty("kind").GetString());
                Check.Equal("player", board.GetProperty("wait").GetProperty("actorId").GetString());
                Check.Equal(2, board.GetProperty("units").GetArrayLength());
                Check.Equal(0, board.GetProperty("masteries").GetArrayLength());
                Check.True(board.GetProperty("recent").GetArrayLength() <= 8);
                Check.True(!board.TryGetProperty("victory", out _) && !board.TryGetProperty("steps", out _));
            }
            var input = new HarnessInputRequest(Id(), s.Version, "敌人正在离开，进行借机攻击");
            var run = await Post<HarnessRunView>(h, id, "harness/runs", input); run = await Settled(h, id, run.Id, 3000);
            Check.True(run.Status == "waiting", "Expected waiting: " + HarnessJson.Serialize(run)); Check.Equal("roll", run.Wait!.Kind); Check.Equal(2, model.Calls); Check.Equal(2, dice.Count);
            s = (await h.Get(id))!; Check.True(s.Combat!.Units.Single(u => u.Id == "player").ReactionAvailable);
            var roll = new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll");
            string data = h.Root; await h.DisposeAsync(); h = await Host.Start(data, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var resolved = await Post<ActionResponse>(h, id, "rolls/respond", roll); s = resolved.Snapshot;
            Check.Equal(3, dice.Count); Check.Equal(47, s.Combat!.Units.Single(u => u.Id == "guardian").HitPoints);
            run = await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), s.Version));
            run = await Settled(h, id, run.Id, 3000); Check.Equal("completed", run.Status); Check.Equal(3, model.Calls);
            await h.DisposeAsync(); h = await Host.Start(data, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var replay = await Post<ActionResponse>(h, id, "rolls/respond", roll); Check.True(replay.Replayed);
            Check.Equal(HarnessJson.Serialize(resolved.Resolution), HarnessJson.Serialize(replay.Resolution));
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed); Check.Equal(3, dice.Count); Check.Equal(3, model.Calls);
            Console.WriteLine("STANDARD real Node/Pi/MCP: public v10 board -> reaction proposal -> zero new dice -> restart own consent -> one attack -> resume -> restart receipt; 3 fake model calls, 0 real calls.");
        }
        finally { await h.DisposeAsync(); }
    }
}
