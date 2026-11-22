using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class StandardCombatBrowserFixture
{
    public static async Task Run(string statePath)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop")) throw new InvalidOperationException("Use a fresh fixture path.");
        var root = Path.Combine(Path.GetTempPath(), "dicerealm-combat-browser-" + Guid.NewGuid());
        var model = new Model((n, r) =>
        {
            if (n == 1) return Tool("context_read");
            if (n == 2)
            {
                using var doc = JsonDocument.Parse(r.Messages.Last(m => m.Name == "context_read").Content);
                string id = doc.RootElement.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                    .Single(x => x.GetProperty("label").GetString()!.StartsWith("Shield /", StringComparison.Ordinal)).GetProperty("id").GetString()!;
                return Tool("actions_propose", new { candidateId = id });
            }
            if (n == 3) return Text("隔离战斗验证：Shield已消耗一次反应与一环法术位，挡住原攻击；没有掷伤害骰，移动已继续。重开不会再次消耗资源。");
            throw new InvalidOperationException("Unexpected fixture input; actual providers disabled.");
        });
        var dice = new SequenceDice(20, 1, 11); CreatedCampaign? owner = null; string? address = null; int boots = 0;
        while (true)
        {
            await using var h = await Host.Start(root, dice: dice, configure: b =>
            {
                Configure(model)(b); if (address is not null) b.WebHost.UseUrls(address);
                b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
                foreach (string prefix in new[] { "TextAi", "ImageAi", "HarnessAi", "PreparationAi" })
                { b.Configuration[prefix + ":ApiKey"] = ""; b.Configuration[prefix + ":Model"] = ""; }
            });
            address = h.Http.BaseAddress!.GetLeftPart(UriPartial.Authority);
            if (owner is null)
            {
                owner = await Create(h, StandardCombatTests.Document(), CharacterEngine.Wizard);
                var s = (await Post<ActionResponse>(h, owner.Snapshot.Id, "character/commands", new CharacterPlayRequest(Id(), owner.Snapshot.Version, "equip", "quarterstaff", 0))).Snapshot;
                s = (await h.Act(s, "combat.start")).Snapshot;
                s = (await Post<ActionResponse>(h, s.Id, "rolls/respond", new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll"))).Snapshot;
                s = (await h.Act(s, "combat.move", "0,2")).Snapshot;
                Check.Equal("shield", s.Combat!.Standard!.Wait!.Kind); Check.Equal(3, dice.Count);
            }
            boots++;
            JsonFiles.Write(statePath, new { baseUrl = address, dataPath = root, processId = Environment.ProcessId, boots, campaignId = owner.Snapshot.Id });
            JsonFiles.Write(statePath + ".connection.json", new { baseUrl = address, campaignId = owner.Snapshot.Id, accessToken = owner.AccessToken });
            Console.WriteLine("Isolated standard combat browser fixture ready (boot " + boots + ").");
            while (!File.Exists(statePath + ".stop") && !File.Exists(statePath + ".restart"))
            {
                JsonFiles.Write(statePath + ".stats", new { boots, diceCount = dice.Count, fakeModelCalls = model.Calls, actualProvider = "disabled" });
                await Task.Delay(200);
            }
            if (File.Exists(statePath + ".stop")) return;
            File.Delete(statePath + ".restart");
        }
    }
}
