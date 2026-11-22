using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class AdvancementRestChoicePiTests
{
    public static async Task OfferedSourceWaitsForOwnConfirmation()
    {
        var dice = new SequenceDice();
        var model = new Model((n, r) =>
        {
            if (n == 1) return Tool("context_read");
            if (n == 2)
            {
                using var json = JsonDocument.Parse(r.Messages.Last(m => m.Name == "context_read").Content);
                var offered = json.RootElement.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                    .Single(c => c.GetProperty("category").GetString() == "rest-choice" && c.GetProperty("label").GetString()!.EndsWith("→ Acid Splash", StringComparison.Ordinal));
                Check.True(!offered.TryGetProperty("character", out _), "Frozen commands are not writable model arguments");
                return Tool("actions_propose", new { candidateId = offered.GetProperty("id").GetString() });
            }
            if (n == 3) return Text("高等精灵来源的戏法已经更换，其他来源保持不变。");
            throw new Exception("Unexpected model call");
        });
        var configure = Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var build = AdvancementRestChoiceTests.HighElfBuild();
            var created = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("休息来源Pi隔离", build.Identity.Name, TestContent.Document, Preset, Build: build));
            Check.True(created.IsSuccessStatusCode); var owner = (await created.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            string id = owner.Snapshot.Id; var s = (await h.Rest(owner.Snapshot, "long")).Snapshot;
            var old = await h.App.Services.GetRequiredService<GameService>().HarnessTool(id, owner.AccessToken, "player", Id(), "长休后更换高等精灵戏法 Acid Splash", s.Version, Id(), "old-read",
                new("context_read", HarnessJson.Element(new { }), Id()), [], CancellationToken.None, new(Preset, HarnessJson.ProfileHash(Preset, []), []), toolContractVersion: 10);
            using (var json = JsonDocument.Parse(old.Reply.Content))
                Check.True(!json.RootElement.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray().Any(c => c.GetProperty("category").GetString() == "rest-choice"));
            string before = JsonSerializer.Serialize(s.Character);
            var input = new HarnessInputRequest(Id(), s.Version, "长休后把高等精灵来源戏法更换为 Acid Splash");
            var run = await Post<HarnessRunView>(h, id, "harness/runs", input); run = await Settled(h, id, run.Id, 3000);
            Check.Equal("waiting", run.Status); Check.Equal("intent", run.Wait!.Kind); Check.Equal(2, model.Calls);
            s = (await h.Get(id))!; Check.Equal(before, JsonSerializer.Serialize(s.Character)); Check.Equal(0, dice.Count);
            var confirm = new IntentResponseRequest(Id(), s.Version, s.PendingIntent!.Id, "choose", s.PendingIntent.Options.Single().Id);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var changed = await Post<ActionResponse>(h, id, "intents/respond", confirm); s = changed.Snapshot;
            Check.True(s.Character.Required().BuildMechanics!.SpellGrants.Any(g => g.Source == "species:elf/lineage:high-elf" && g.Id == "acid-splash"));
            Check.Equal(0, dice.Count);
            run = await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), s.Version));
            run = await Settled(h, id, run.Id, 3000); Check.Equal("completed", run.Status); Check.Equal(3, model.Calls);
            await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var replay = await Post<ActionResponse>(h, id, "intents/respond", confirm); Check.True(replay.Replayed);
            Check.Equal(HarnessJson.Serialize(changed.Resolution), HarnessJson.Serialize(replay.Resolution));
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed); Check.Equal(3, model.Calls); Check.Equal(0, dice.Count);
            Console.WriteLine("REST v11 actual Node/Pi/MCP: offered source -> own pending intent/zero effect -> restart/confirm -> resume -> restart receipt; 3 fake model calls, 0 actual provider calls.");
            Check.Equal("70e2203d3e22fa6c040d1c5d29eab59369e1a901837edbf0acfa2b3d20550849", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(11))));
        }
        finally { await h.DisposeAsync(); }
    }
}
