using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;
using static DiceRealm.Tests.GameSaveTests;

namespace DiceRealm.Tests;

internal static class GameSaveRecoveryTests
{
    public static async Task RestoredMapLeaseCannotSendOrComplete()
    {
        var images = new TestImages();
        await using var h = await Host.Start(images: images, configure: Configure(new Model((_, _) => throw new Exception("No model")), extra: b =>
        {
            var worker = b.Services.Single(d => d.ImplementationType == typeof(MapWorker)); b.Services.Remove(worker);
        }));
        var owner = await Create(h); string id = owner.Snapshot.Id; var maps = h.App.Services.GetRequiredService<MapCatalog>();
        var map = maps.Create(id, AssetTests.Create()); maps.Generate(id, map.Id, AssetTests.Generate(map)); var lease = maps.Claim()!;
        Check.True(lease is not null); Check.Equal("generating", maps.Get(id, map.Id, true).Status);
        var save = await Save(h, id, "图片已排队"); var entry = await Entry(h, id, save.GetProperty("saveId").GetString()!);
        maps.Complete(lease!, AssetTests.Png); Check.Equal("ready", maps.Get(id, map.Id, true).Status);
        await Load(h, id, entry); var restored = maps.Get(id, map.Id, true);
        Check.Equal("failed", restored.Status); Check.Equal("map_generation_restored_unknown", restored.Error); Check.True(maps.Claim() is null);
        maps.Complete(lease!, AssetTests.Png); maps.Fail(lease!, "late-error");
        Check.Equal(restored.Version, maps.Get(id, map.Id, true).Version); Check.Equal(restored.Error, maps.Get(id, map.Id, true).Error);
        var guard = typeof(MapCatalog).GetMethod("RequireGenerationLease", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        try { guard.Invoke(maps, [lease]); throw new Exception("Old lease allowed sending"); }
        catch (System.Reflection.TargetInvocationException error) { Check.True(error.InnerException is ImageGenerationException); }
        Check.Equal(0, images.Calls);
    }

    public static async Task JournalCommitMarkerAndCorruptPayload()
    {
        foreach (bool committed in new[] { false, true })
        {
            var model = new Model((_, _) => throw new Exception("Recovery cannot call a model"));
            var h = await Host.Start(configure: Configure(model));
            try
            {
                var owner = await Create(h); string id = owner.Snapshot.Id;
                var map = SharedBoardTests.Install(h, id);
                var a = await Save(h, id, "before");
                await Mutate(h, owner, c => c.Character = c.Character.Required() with { HitPoints = 1 });
                h.App.Services.GetRequiredService<MapCatalog>().Publish(id, map.Id, new(Id(), map.Version, false, false));
                var b = await Save(h, id, "after");
                string folder = Path.Combine(h.Root, "game-saves", id);
                var index = JsonNode.Parse(File.ReadAllText(Path.Combine(folder, "index.json")))!;
                string Payload(JsonElement response) => index["entries"]!.AsArray().Single(e => e!["view"]!["id"]!.GetValue<string>() == response.GetProperty("saveId").GetString())!["payloadId"]!.GetValue<string>();
                string before = Payload(a), after = Payload(b);
                // A missing payload file is rejected before touching the active state.
                string manifest = Path.Combine(folder, "payloads", before, "manifest.json");
                string original = File.ReadAllText(manifest); File.WriteAllText(manifest, "{}");
                var current = await Get(h, id);
                await Error(await h.Http.PostAsJsonAsync(Url(id, "adventure/saves/" + a.GetProperty("saveId").GetString() + "/load"), new { requestId = Id(), expectedVersion = current.GetProperty("version").GetInt32(), expectedSaveRevision = 1 }), HttpStatusCode.Conflict, "game_save_corrupt");
                Check.Equal(current.GetRawText(), (await Get(h, id)).GetRawText()); Check.True(!File.Exists(Path.Combine(folder, "restore.json")));
                File.WriteAllText(manifest, original);
                // Simulate either side of the durable commit marker with mixed current stores.
                var receipt = index["receipts"]!.AsArray().Last()!;
                string requestId = committed ? receipt["requestId"]!.GetValue<string>() : Id();
                string fingerprint = committed ? receipt["fingerprint"]!.GetValue<string>() : new string('a', 64);
                string root = h.Root; await h.DisposeAsync();
                JsonFiles.Write(Path.Combine(folder, "restore.json"), new { schemaVersion = 1, campaignId = id, beforeId = before, afterId = after, requestId, fingerprint });
                h = await Host.Start(root, configure: Configure(model)); Auth(h, owner.AccessToken);
                var restored = (await h.Get(id))!;
                Check.Equal(committed ? 1 : owner.Snapshot.Character.Required().HitPoints, restored.Character.Required().HitPoints);
                Check.Equal(!committed, h.App.Services.GetRequiredService<MapCatalog>().Get(id, map.Id, true).Published);
                Check.True(!File.Exists(Path.Combine(folder, "restore.json"))); Check.Equal(0, model.Calls);
                // Both stored slots remain selectable after recovery.
                Check.Equal(2, (await Get(h, id, "adventure/saves")).GetProperty("entries").GetArrayLength());
            }
            finally { await h.DisposeAsync(); }
        }
    }
}
