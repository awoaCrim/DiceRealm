using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessInventoryTests
{
    private static byte[] Bytes(string path)
    {
        // While Pi is running, read-only GETs can hold SQLite read/write handles on Windows.
        // These observations must allow that share; the model/tool sequence still bounds writes.
        using var file = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var copy = new MemoryStream(); file.CopyTo(copy); return copy.ToArray();
    }

    public static async Task AcquisitionsPersistThroughPiAndReplay()
    {
        string database = ""; byte[] before = []; Exception? failure = null;
        var source = new StoryItemSource("current_scene", "harbor", "莫娜备有一根绳索、三根火炬和莫娜的介绍信，允许来访者收下。");
        var grants = new[] { new StoryItemGrant("rope", "", 1, source), new StoryItemGrant("torch", "", 3, source), new StoryItemGrant("", "莫娜的介绍信", 1, source) };
        var model = new Model((call, request) =>
        {
            try
            {
                if (call == 1)
                {
                    before = Bytes(database);
                    return Tool("world_record", new NarrativeHarnessArgs("这份非法批次不能留下叙事。", [], Items: [grants[0], new("torch", "不能覆盖目录名称", 3, source)]));
                }
                if (call == 2)
                {
                    Check.True(before.SequenceEqual(Bytes(database)), "Invalid item batch must roll back the root, inventory, narrative and receipts");
                    var rejected = request.Messages.Last(m => m.Role == "tool");
                    Check.True(rejected.IsError == true);
                    using var json = JsonDocument.Parse(rejected.Content);
                    Check.Equal("invalid_story_items", json.RootElement.GetProperty("code").GetString());
                    return Tool("world_record", new NarrativeHarnessArgs("莫娜把麻绳、三根火把和介绍信交给了你。", [], Items: grants, Complete: false));
                }
                if (call == 3)
                {
                    before = Bytes(database);
                    return Tool("world_record", new NarrativeHarnessArgs("不能用不同数量重复发物。", [], Items: [new("rope", "", 2, source)]));
                }
                if (call == 4)
                {
                    Check.True(before.SequenceEqual(Bytes(database)), "Conflicting grant quantity must leave the committed acquisition unchanged");
                    Check.True(request.Messages.Last(m => m.Role == "tool").IsError == true);
                    return Tool("world_record", new NarrativeHarnessArgs("物品已经装好。", [], Items: grants));
                }
                return Text("你收好麻绳、三根火把和介绍信，向莫娜道谢。");
            }
            catch (Exception error) { failure = error; throw; }
        });
        var configure = Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var host = await Host.Start(configure: configure);
        try
        {
            var owner = await Create(host, HarnessItemSearchTests.WithEvidence(source.Detail)); var guest = await HarnessBoundaryTests.Guest(host, owner);
            string id = owner.Snapshot.Id, actor = guest.Snapshot.Party!.SelfActorId;
            database = Path.Combine(host.Root, "campaigns", id + ".sqlite");
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var snapshot = (await host.Get(id))!;
            int Count(CampaignSnapshot s, string item) => s.Character!.Inventory.FirstOrDefault(i => i.Id == item)?.Quantity ?? 0;
            int rope = Count(snapshot, "rope"), torch = Count(snapshot, "torch");
            var request = new HarnessInputRequest(Id(), snapshot.Version, "收下麻绳、三根火把和介绍信");
            var run = await Settled(host, id, (await Post<HarnessRunView>(host, id, "harness/runs", request)).Id, 3000);
            Check.True(run.Status == "completed", run.Status + "/" + run.Error + " " + failure);
            Check.Equal(4, model.Calls);
            snapshot = (await host.Get(id))!;
            Check.Equal(rope + 1, Count(snapshot, "rope")); Check.Equal(torch + 3, Count(snapshot, "torch"));
            var letter = snapshot.Character!.Inventory.Single(i => i.Name == "莫娜的介绍信");
            Check.True(letter.Id.StartsWith("story-item:") && !letter.Equipped); Check.Equal(1, letter.Quantity);
            var activity = (await host.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!;
            var entry = activity.Entries.Single(e => e.ActionId == run.IntentId);
            var acquired = entry.Steps!.Single(step => step.Result.Kind == "inventory.grant");
            Check.Equal(3, acquired.Origin!.Changes.Length); Check.True(acquired.Origin.Changes.All(change => change.ActorId == actor));
            Check.Equal(run.Text, entry.Narrative);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var ownerNow = (await host.Get(id))!;
            Check.True(!ownerNow.Character!.Inventory.Any(i => i.Name == "莫娜的介绍信"));
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            Check.True((await Post<HarnessRunView>(host, id, "harness/runs", request)).Replayed);
            var store = host.App.Services.GetRequiredService<HarnessRunStore>();
            var saved = store.Read(id, actor, run.Id)!;
            var tool = saved.Steps.First(step => step.ToolName == "world_record" && step.Outcome?.Reply.IsError == false);
            // Game committed but Run output lost: the original command must replay, even at an old version.
            var game = host.App.Services.GetRequiredService<GameService>();
            var receipt = await game.HarnessTool(id, guest.AccessToken, actor, run.IntentId, request.Text, request.ExpectedVersion,
                tool.CommandId, "harness:" + tool.Fingerprint, tool.ToolRequest!, [], default, saved.Profile, 18, true, []);
            Check.Equal(HarnessJson.Serialize(tool.Outcome), HarnessJson.Serialize(receipt));
            string root = host.Root; await host.DisposeAsync();
            host = await Host.Start(root, configure: Configure(model, extra: b => b.Configuration["Harness:Enabled"] = "false"));
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            Check.True((await Post<HarnessRunView>(host, id, "harness/runs", request)).Replayed);
            snapshot = (await host.Get(id))!;
            Check.Equal(rope + 1, Count(snapshot, "rope")); Check.Equal(torch + 3, Count(snapshot, "torch")); Check.Equal(4, model.Calls);
        }
        finally { await host.DisposeAsync(); }
    }

    public static async Task StrictAcquisitionBoundaryAndPlainNarrative()
    {
        var model = new Model((_, _) => Text("我在故事里说你得到了十根火把。"));
        await using var host = await Host.Start(configure: Configure(model)); var owner = await Create(host);
        string id = owner.Snapshot.Id;
        var game = host.App.Services.GetRequiredService<GameService>(); var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
        string database = Path.Combine(host.Root, "campaigns", id + ".sqlite"); byte[] bytes = File.ReadAllBytes(database);
        async Task Reject(NarrativeHarnessArgs args, int version, string code)
        {
            try
            {
                await game.HarnessTool(id, owner.AccessToken, auth.ActorId, Id(), "拿道具", auth.Version, Id(), Id(),
                    new("world_record", HarnessJson.Element(args), "tool"), [], default, auth.Profile, version, true, []);
                throw new Exception("Expected rejection");
            }
            catch (GameException error) { Check.Equal(code, error.Code); }
            Check.True(bytes.SequenceEqual(File.ReadAllBytes(database)));
        }
        await Reject(new("无效", [], Items: [new("rope", "", 1)]), 17, "harness_invalid_payload");
        await Reject(new("无效", [], Items: [new("not-a-real-item", "", 1)]), 18, "invalid_story_items");
        await Reject(new("无效", [], Items: [new("rope", "重命名的神器", 1)]), 18, "invalid_story_items");
        await Reject(new("无效", [], Items: [new("", "", 1)]), 18, "invalid_story_items");
        await Reject(new("无效", [], Items: [new("rope", "", 1), new("rope", "", 1)]), 18, "invalid_story_items");
        await Reject(new("无效", [new("invented", "clue", "线索", "不应该保存", "known", "harbor")], Items: [new("rope", "", 1)]), 18, "invalid_world_memory");
        Check.True(!HarnessTools.ForVersion(17).Single(t => t.Name == "world_record").InputSchema.GetProperty("properties").TryGetProperty("items", out _));
        var original = owner.Snapshot.Character!.Inventory;
        await Settled(host, id, (await Start(host, owner.Snapshot, "纯叙事对照")).Id);
        Check.Equal(HarnessJson.Serialize(original), HarnessJson.Serialize((await host.Get(id))!.Character!.Inventory));
        Check.Equal(1, model.Calls);
    }
}
