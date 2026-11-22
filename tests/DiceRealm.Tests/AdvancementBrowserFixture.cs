using System.Net;
using System.Net.Http.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Hosting;

namespace DiceRealm.Tests;

// Opt-in real browser harness. Production endpoints only; temporary database, no
// providers, no test routes. Credentials stay in a user-selected local state file.
internal static class AdvancementBrowserFixture
{
    public static async Task Run(string statePath)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop") || File.Exists(statePath + ".restart"))
            throw new InvalidOperationException("Use a new fixture state path.");
        string root = Path.Combine(Path.GetTempPath(), "dicerealm-growth-browser-" + Guid.NewGuid());
        string? address = null;
        CreatedCampaign? owner = null;
        var dice = new SequenceDice();
        int boots = 0;
        while (true)
        {
            await using var host = await Host.Start(root, dice, configure: builder =>
            {
                if (address is not null) builder.WebHost.UseUrls(address);
                foreach (string prefix in new[] { "TextAi", "ImageAi", "HarnessAi", "PreparationAi" })
                {
                    builder.Configuration[prefix + ":ApiKey"] = "";
                    builder.Configuration[prefix + ":Model"] = "";
                }
            });
            address = host.Http.BaseAddress!.GetLeftPart(UriPartial.Authority);
            if (owner is null)
            {
                var build = AdvancementRestChoiceTests.HighElfBuild() with
                {
                    Identity = new() { Name = "成长浏览器隔离角色" }, BaseScores = [13, 12, 14, 15, 10, 8], BackgroundBonuses = [0, 0, 0, 2, 1, 0]
                };
                var created = await host.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("成长浏览器隔离验证", build.Identity.Name,
                    Adventure: TestContent.Document, Prompts: TestContent.Prompts, StartImmediately: true, Build: build));
                Check.Equal(HttpStatusCode.Created, created.StatusCode);
                owner = (await created.Content.ReadFromJsonAsync<CreatedCampaign>())!;
                host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                string path = "/api/v1/campaigns/" + owner.Snapshot.Id;
                var award = await host.Http.PostAsJsonAsync(path + "/characters/advancement/award",
                    new AwardAdvancementRequest(Guid.NewGuid().ToString(), owner.Snapshot.Version, PartyEngine.HostId, "milestone", 5, "仅隔离验证：明确授予到五级"));
                Check.Equal(HttpStatusCode.OK, award.StatusCode);
                var awarded = (await award.Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot;
                await host.Rest(awarded, "long");
            }
            boots++;
            JsonFiles.Write(statePath, new { baseUrl = address, dataPath = root, processId = Environment.ProcessId, boots,
                campaignId = owner.Snapshot.Id });
            JsonFiles.Write(statePath + ".connection.json", new { baseUrl = address, campaignId = owner.Snapshot.Id, accessToken = owner.AccessToken });
            Console.WriteLine("Isolated growth browser fixture ready (boot " + boots + ").");
            while (!File.Exists(statePath + ".stop") && !File.Exists(statePath + ".restart"))
            {
                JsonFiles.Write(statePath + ".stats", new { boots, diceCount = dice.Count, provider = "disabled" });
                await Task.Delay(200);
            }
            if (File.Exists(statePath + ".stop")) return;
            File.Delete(statePath + ".restart");
        }
    }
}
