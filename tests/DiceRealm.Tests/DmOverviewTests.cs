using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;
using static DiceRealm.Tests.GameSaveTests;

namespace DiceRealm.Tests;

internal static class DmOverviewTests
{
    internal static async Task<CreatedCampaign> Scenario(Host h, string name, SequenceDice dice, bool hidden = false, bool combat = false, bool hostOnly = false, byte[]? mapImage = null)
    {
        var document = TestContent.Document with { Scenes = TestContent.Document.Scenes.Select(s => s with { Encounter = null }).ToArray() };
        var response = await h.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest(name, hostOnly ? "" : "云雀",
            Adventure: document, Prompts: TestContent.Prompts, StartImmediately: true,
            Build: hostOnly ? null : FullCreationTests.Named("云雀", CharacterEngine.Wizard)));
        Check.Equal(HttpStatusCode.Created, response.StatusCode);
        var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!; Auth(h, owner.AccessToken);
        var map = hidden ? SharedBoardTests.Install(h, owner.Snapshot.Id, png: mapImage ?? SharedBoardTests.MapPng(768, 512)) with { CurrentScene = true } : null;
        if (map is not null && combat)
        {
            var maps = h.App.Services.GetRequiredService<MapCatalog>();
            map = maps.ConfigureGrid(owner.Snapshot.Id, map.Id, new(Id(), map.Version,
                new() { Type = "square", CellPixels = 64, Distance = 5, Units = "feet", Uncalibrated = false }, "tactical"));
            map = maps.Publish(owner.Snapshot.Id, map.Id, new(Id(), map.Version, true, true)) with { CurrentScene = true };
        }
        await Mutate(h, owner, c =>
        {
            var index = WorldMemoryIndex.For(c);
            index.Upsert(new("keeper-secret", "npc", "守港人的秘密", "他把灯塔钥匙藏在铜灯底座，尚未告诉队伍。", "known", c.SceneId, 1, 0, c.Version, PartyEngine.HostId, "host", Visibility: "host"));
            index.Upsert(new("scene-note", "clue", "主持备注", "东北堆箱后埋伏着弓手；保持原有伏兵，不重复生成。", "active", c.SceneId, 1, 0, c.Version, PartyEngine.HostId, "host", Visibility: "host"));
            index.Upsert(new("other-secret", "clue", "其他场景", "OTHER_SCENE_SECRET", "known", "causeway", 1, 0, c.Version, PartyEngine.HostId, "host", Visibility: "host"));
            if (c.Character is { } character) c.Character = character with { TemporaryHitPoints = 4, Concentration = new("blade-ward", "fixture", 3600) };
            if (map is null) return;
            var spawns = PartyEngine.Characters(c).Select((p, i) => new BoardSpawn("", "creature", new("player", p.Id), new(p.Character.Name), 1.5 / 12, (i + 1.5) / 8, p.Id)).ToArray();
            SharedBoard.Execute(c, map, new(Id(), c.Version, map.Id, "spawn", Spawns: spawns, ExpectedMapVersion: map.Version), narrator: true, controlPlayers: true);
            var placements = new[] { new EncounterPlacement("xmm:goblin-warrior", "堆箱后的伏兵", "ranged", new(5.5 / 12, 2.5 / 8), "three-quarters-cover", "堆箱提供四分之三掩护，未进入队伍视线。") };
            var setup = RuntimeEncounters.Prepare(c, map, combat ? MapScale.TacticalGrid(map) : null,
                "雾港伏兵", c.SceneId, "隔离场景中的埋伏准备", "沿码头堆箱布置", placements,
                combat ? [new(3, 2, "three-quarters-cover")] : [], namingVersion: 56);
            setup = RuntimeEncounters.Establish(c, map, setup, placements, new RulesEngine(dice));
            if (combat)
            {
                c.RuntimeEncounters![0] = setup with { EngagementReason = "隔离实际交锋" };
                c.BoardMapContext = map; new CombatEngine(dice).Resolve(c, "combat.start", "");
            }
        });
        await h.App.Services.GetRequiredService<CampaignStore>().Access(owner.Snapshot.Id, owner.AccessToken, true, c =>
        {
            c.Version++;
            c.Events.Add(new(Id(), c.Version, "observe", "查看码头", "海雾从木桩之间漫上来，远处旧灯塔的轮廓几乎隐没。港口信使守在栈桥旁，将一封被雨打湿的信收入斗篷。\n\n“船队还没有回来。”她望着黑暗中的航道，压低了声音。\n\n你仍站在码头入口，可以继续询问信使，也可以观察通往堆箱区的石板小径。", "authored", DateTimeOffset.UtcNow, null,
                Origin: new("我停下脚步，看看码头周围。", "观察", "observe", "", "云雀", c.SceneId, "雾港码头", [])));
            return Task.FromResult(true);
        });
        return owner;
    }

    public static async Task PermissionsPrivacyAndReadOnly()
    {
        var dice = new SequenceDice(20); var model = new Model((_, _) => throw new Exception("No provider in DM reads"));
        await using var h = await Host.Start(dice: dice, configure: Configure(model));
        var owner = await Scenario(h, "DM概览权限", dice, hidden: true);
        var guest = await HarnessBoundaryTests.Guest(h, owner); Auth(h, owner.AccessToken);
        string file = Path.Combine(h.Root, "campaigns", owner.Snapshot.Id + ".sqlite"); byte[] before = File.ReadAllBytes(file);
        var view = await Get(h, owner.Snapshot.Id, "dm/overview");
        Check.Equal(owner.Snapshot.Id, view.GetProperty("campaignId").GetString());
        Check.Equal((await h.Get(owner.Snapshot.Id))!.Version, view.GetProperty("version").GetInt32());
        Check.Equal(2, view.GetProperty("party").GetArrayLength());
        Check.True(view.GetRawText().Contains("灯塔钥匙") && view.GetRawText().Contains("堆箱后的伏兵"));
        Check.True(!view.GetRawText().Contains("OTHER_SCENE_SECRET"));
        Check.Equal(2, view.GetProperty("board").GetProperty("tokens").GetArrayLength());
        var encounter = view.GetProperty("encounter").GetProperty("encounter");
        Check.Equal(JsonValueKind.Null, encounter.GetProperty("layout").ValueKind);
        Check.True(encounter.GetProperty("concealment")[0].GetProperty("hidden").GetBoolean());
        await Get(h, owner.Snapshot.Id, "dm/overview");
        Check.True(before.SequenceEqual(File.ReadAllBytes(file))); Check.Equal(1, dice.Count); Check.Equal(0, model.Calls);
        Auth(h, guest.AccessToken);
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.GetAsync(Url(owner.Snapshot.Id, "dm/overview"))).StatusCode);
        var publicView = await Get(h, owner.Snapshot.Id);
        Check.True(!publicView.GetRawText().Contains("灯塔钥匙") && !publicView.GetRawText().Contains("堆箱后的伏兵"));
        string mapId = view.GetProperty("board").GetProperty("map").GetProperty("id").GetString()!;
        var board = await Get(h, owner.Snapshot.Id, "maps/" + mapId + "/board");
        Check.True(!board.GetRawText().Contains("堆箱后的伏兵"));
    }

    public static async Task EmptyHostAndCombat()
    {
        var dice = new SequenceDice(20, 19, 1); var model = new Model((_, _) => throw new Exception("No provider"));
        await using var h = await Host.Start(dice: dice, configure: Configure(model));
        var owner = await Scenario(h, "无角色主持", dice, hostOnly: true);
        var view = await Get(h, owner.Snapshot.Id, "dm/overview");
        Check.Equal(0, view.GetProperty("party").GetArrayLength()); Check.Equal(JsonValueKind.Null, view.GetProperty("board").ValueKind);
        Check.True(view.GetRawText().Contains("灯塔钥匙"));
        var battle = await Scenario(h, "战斗概览并存", dice, hidden: true, combat: true);
        var dm = await Get(h, battle.Snapshot.Id, "dm/overview");
        var fight = await Get(h, battle.Snapshot.Id, "combat/overview");
        Check.Equal("active", fight.GetProperty("combat").GetProperty("status").GetString());
        Check.True(dm.GetProperty("board").GetProperty("tokens").EnumerateArray().Any(t => t.GetProperty("name").GetString() == "堆箱后的伏兵"));
        Check.Equal(3, dice.Count); Check.Equal(0, model.Calls);
    }

    public static async Task Browser(string statePath)
    {
        statePath = Path.GetFullPath(statePath); if (File.Exists(statePath)) throw new InvalidOperationException("Use fresh evidence path");
        var dice = new SequenceDice(20, 20, 19, 1); var model = new Model((_, _) => throw new Exception("No provider"));
        await using var h = await Host.Start(dice: dice, configure: Configure(model)); AccountTests.SeedAdminFixture(h);
        // The retained W-C illustration is only installed in this isolated visual room.
        // Normal tests retain their synthetic geometry; no sample asset enters production.
        using var illustration = SkiaSharp.SKImage.FromEncodedData("artifacts/ui-design-iteration/v2/assets/map.jpg");
        using var mapPng = illustration.Encode(SkiaSharp.SKEncodedImageFormat.Png, 100);
        var exploration = await Scenario(h, "W1 · 雾港暗潮", dice, hidden: true, mapImage: mapPng.ToArray());
        var explorationPlayer = await HarnessBoundaryTests.Guest(h, exploration);
        await HarnessBoundaryTests.Guest(h, exploration);
        await Mutate(h, exploration, c =>
        {
            c.PartyMembers[0].Character = c.PartyMembers[0].Character with { Name = "岑野" };
            c.PartyMembers[1].Character = c.PartyMembers[1].Character with { Name = "苏娅", HitPoints = 3 };
        });
        await Mutate(h, exploration, c => c.PendingRulings.Add(new(Id(), "我想悄悄挪开堆箱，看看后面有什么。", "pending", "检查可能的噪声与掩护变化。")));
        var battle = await Scenario(h, "W1 · 码头交锋", dice, hidden: true, combat: true);
        var noMap = await Scenario(h, "W1 · 暂无地图", dice);
        var host = await Scenario(h, "W1 · 无角色主持", dice, hostOnly: true);
        // Visual QA also needs an active prompt editor and real log endpoints. These are
        // isolated, explicitly seeded records: no model request is sent to a provider.
        var editor = await Create(h);
        var log = h.App.Services.GetRequiredService<ModelRequestLog>();
        string request = JsonSerializer.Serialize(new { messages = new[] {
            new { role = "system", content = "隔离视觉样例：根据已保存的场景事实主持冒险。" },
            new { role = "user", content = "我走向栈桥，向守港人询问灯塔的情况。" } } });
        long failed = log.Start("OpenAiHarnessModel", new(editor.Snapshot.Id, "visual-request", "询问灯塔", 1), "POST", "https://fixture.invalid/v1/chat/completions", request);
        log.Finish(failed, 503, "隔离样例 · HTTP 503", 320, "服务暂不可用（隔离样例）");
        long succeeded = log.Start("OpenAiHarnessModel", new(editor.Snapshot.Id, "visual-request", "询问灯塔", 2), "POST", "https://fixture.invalid/v1/chat/completions", request);
        log.Finish(succeeded, 200, "", 1640, JsonSerializer.Serialize(new { choices = new[] { new { message = new { role = "assistant", content = "守港人指向远处熄灭的灯塔。雨水从檐角滴落，他示意你靠近些。\n\n这些内容仅用于隔离视觉验收，不来自模型调用。" } } } }));
        string baseUrl = h.Http.BaseAddress!.GetLeftPart(UriPartial.Authority);
        JsonFiles.Write(statePath + ".player.json", new { baseUrl, campaignId = exploration.Snapshot.Id, accessToken = explorationPlayer.AccessToken });
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(statePath + ".player.json", UnixFileMode.UserRead | UnixFileMode.UserWrite);
        JsonFiles.Write(statePath, new { baseUrl, dataPath = h.Root,
            campaigns = new { exploration = exploration.Snapshot.Id, battle = battle.Snapshot.Id, noMap = noMap.Snapshot.Id, host = host.Snapshot.Id, editor = editor.Snapshot.Id } });
        Console.WriteLine("DM overview isolated fixture ready");
        while (!File.Exists(statePath + ".stop")) await Task.Delay(250);
        JsonFiles.Write(statePath + ".result", new { dice = dice.Count, modelCalls = model.Calls, paidProviderCalls = 0 });
    }
}
