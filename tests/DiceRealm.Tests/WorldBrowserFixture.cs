using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

// Opt-in fixture for actual embedded workbench interaction; only ordinary product APIs.
// No credentials on stdout, no real model/image adapter, and no mutation test endpoints.
internal static class WorldBrowserFixture
{
    public static async Task Run(string statePath, bool scale = false)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop")) throw new InvalidOperationException("Use a fresh fixture path.");
        var root = Path.Combine(Path.GetTempPath(), "dicerealm-world-browser-" + Guid.NewGuid());
        var model = new Model((n, request) => n switch
        {
            1 or 3 => Tool("context_read"),
            2 => Tool("world_route_propose", new WorldRouteProposal("", "", "mill", 180, true, true, "公开记录已说明往返各三分钟的小路。")),
            4 => Tool("actions_propose", new { candidateId = Candidate(request, "前往隔离旧磨坊") }),
            5 => Tool("world_routes"),
            6 => Text("隔离验证：路线已确认，现已抵达旧磨坊，经过三分钟；未知地图坐标仍未编造。"),
            _ => throw new InvalidOperationException("Unexpected fixture input; do not call a real provider.")
        });
        var dice = new SequenceDice(); var images = new TestImages();
        CreatedCampaign? owner = null; string? address = null; int boots = 0;
        while (true)
        {
            await using var host = await Host.Start(root, dice: dice, images: images, configure: builder =>
            {
                Configure(model)(builder);
                if (address is not null) builder.WebHost.UseUrls(address);
                foreach (string prefix in new[] { "TextAi", "ImageAi", "HarnessAi", "PreparationAi" })
                { builder.Configuration[prefix + ":ApiKey"] = ""; builder.Configuration[prefix + ":Model"] = ""; }
            });
            address = host.Http.BaseAddress!.GetLeftPart(UriPartial.Authority);
            if (owner is null)
            {
                owner = await Create(host, TestContent.Document with { InitialKnowledge =
                [
                    new("mill", "place", "隔离旧磨坊", "小路往返各需三分钟，未提供图面定位。", "", "public"),
                    new("letter", "clue", "隔离公开留言", "村民在港口留下路线说明；此处是记录关联地点，不是人物实时位置。", "harbor", "public"),
                    new("secret", "npc", "SECRET-NPC", "SECRET-BODY", "harbor", "host")
                ] });
                if (scale)
                {
                    await host.App.Services.GetRequiredService<CampaignStore>().Access(owner.Snapshot.Id, owner.AccessToken, true, c =>
                    {
                        WorldMemories.Apply(c, Enumerable.Range(0, 600).Select(i => new WorldMemoryEntry("scale-" + i.ToString("D4"), "clue",
                            "隔离旧案 " + i.ToString("D4"), "第" + i + "份海灯公开档案，仅供分页校验，不结算奖励。", "known", "", 1, 0,
                            c.Version + 1, "player", "fixture")).ToArray());
                        c.Version++; c.Events.Add(new(Id(), c.Version, "fixture", "隔离世界分页夹具", "", "fixture", DateTimeOffset.UtcNow, null));
                        return Task.FromResult(true);
                    });
                }
                else
                {
                var map = await Post<MapAssetView>(host, owner.Snapshot.Id, "maps", AssetTests.Create() with
                { Specification = AssetTests.Create().Specification with { Title = "QA 隔离校验图（非产品美术）" } });
                map = await Post<MapAssetView>(host, owner.Snapshot.Id, $"maps/{map.Id}/markers", new ConfigureMapMarkersRequest(Id(), map.Version,
                    [new(Id(), "scene", "harbor", .25, .75, "player")]));
                await Post<MapAssetView>(host, owner.Snapshot.Id, $"maps/{map.Id}/generate", AssetTests.Generate(map));
                await AssetTests.Until(async () => (await host.Http.GetFromJsonAsync<MapAssetView>($"/api/v1/campaigns/{owner.Snapshot.Id}/maps/{map.Id}"))!.Status == "ready");
                map = (await host.Http.GetFromJsonAsync<MapAssetView>($"/api/v1/campaigns/{owner.Snapshot.Id}/maps/{map.Id}"))!;
                await Post<MapAssetView>(host, owner.Snapshot.Id, $"maps/{map.Id}/publish", new PublishMapRequest(Id(), map.Version, true, true));
                }
            }
            boots++;
            JsonFiles.Write(statePath, new { baseUrl = address, dataPath = root, processId = Environment.ProcessId, boots, campaignId = owner.Snapshot.Id });
            JsonFiles.Write(statePath + ".connection.json", new { baseUrl = address, campaignId = owner.Snapshot.Id, accessToken = owner.AccessToken });
            Console.WriteLine("Isolated world browser fixture ready (boot " + boots + ").");
            while (!File.Exists(statePath + ".stop") && !File.Exists(statePath + ".restart"))
            {
                JsonFiles.Write(statePath + ".stats", new { boots, diceCount = dice.Count, fakeModelCalls = model.Calls, fakeImageCalls = images.Calls, actualProvider = "disabled" });
                await Task.Delay(200);
            }
            if (File.Exists(statePath + ".stop")) return;
            File.Delete(statePath + ".restart");
        }
    }
}
