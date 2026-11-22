using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class NaturalBrowserFixture
{
    public static async Task Run(string statePath)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop")) throw new InvalidOperationException("Use a fresh fixture path.");
        var root = Path.Combine(Path.GetTempPath(), "dicerealm-natural-browser-" + Guid.NewGuid());
        var model = new Model((n, request) =>
        {
            if (n is 1 or 4) return Tool("context_read");
            if (n is 2 or 5)
            {
                using var document = System.Text.Json.JsonDocument.Parse(request.Messages.Last(m => m.Name == "context_read").Content);
                string phrase = n == 2 ? "Second Wind" : "隔离治疗药水";
                string id = document.RootElement.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                    .Single(c => c.GetProperty("category").GetString() == "effect" && c.GetProperty("label").GetString()!.Contains(phrase))
                    .GetProperty("id").GetString()!;
                return Tool("actions_propose", new { candidateId = id });
            }
            if (n is 3 or 6) return Text(n == 3 ? "隔离验证：已使用一次回气，生命由1恢复至6。" : "隔离验证：已饮用治疗药水，生命由6恢复至11，药水已消耗。 ");
            throw new InvalidOperationException("Unexpected fixture input; actual providers disabled.");
        });
        var dice = new SequenceDice(4, 1, 2); CreatedCampaign? owner = null; string? address = null; int boots = 0;
        while (true)
        {
            await using var h = await Host.Start(root, dice: dice, configure: b =>
            {
                Configure(model)(b); if (address is not null) b.WebHost.UseUrls(address);
                foreach (string prefix in new[] { "TextAi", "ImageAi", "HarnessAi", "PreparationAi" })
                { b.Configuration[prefix + ":ApiKey"] = ""; b.Configuration[prefix + ":Model"] = ""; }
            });
            address = h.Http.BaseAddress!.GetLeftPart(UriPartial.Authority);
            if (owner is null)
            {
                var doc = TestContent.Document with
                {
                    Items = [..TestContent.Document.Items, new("fixture-potion", "隔离治疗药水", NaturalActions.HealingPotion)],
                    Scenes = TestContent.Document.Scenes.Select(s => s.Id == "harbor" ? s with { Actions = [..s.Actions,
                        new() { Id = "fixture-supply", Kind = "script.supply", Label = "领取隔离验证药水", Success = new("领取一瓶仅供隔离验证的治疗药水。", [new("item", "fixture-potion", 1)]) }] } : s).ToArray()
                };
                owner = await Create(h, doc);
                var state = (await h.Act(owner.Snapshot, "script.supply")).Snapshot;
                await Post<ActionResponse>(h, state.Id, "characters/adjust", new AdjustCharacterRequest(Id(), state.Version, "player", "隔离治疗夹具起始伤势", "测试夹具", [new("hp", "", 1)]));
            }
            boots++;
            JsonFiles.Write(statePath, new { baseUrl = address, dataPath = root, processId = Environment.ProcessId, boots, campaignId = owner.Snapshot.Id });
            JsonFiles.Write(statePath + ".connection.json", new { baseUrl = address, campaignId = owner.Snapshot.Id, accessToken = owner.AccessToken });
            Console.WriteLine("Isolated natural effect browser fixture ready (boot " + boots + ").");
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
