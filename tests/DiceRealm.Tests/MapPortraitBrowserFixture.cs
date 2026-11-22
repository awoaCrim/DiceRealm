using System.Text.Json;
using System.Text.RegularExpressions;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

// Isolated native-Player acceptance: UI creates the campaign and submits the character.
// Files release fake provider responses so screenshots can inspect the actual pending states.
internal static class MapPortraitBrowserFixture
{
    private sealed class Images(string statePath, string sourceImage) : IMapImageGenerator
    {
        public int Calls;
        public bool Enabled => true;
        public string CacheIdentity => "native-portrait-fixture-v1";
        public Task<byte[]> Generate(MapGenerationJob job, CancellationToken ct) => throw new InvalidOperationException("Fixture only imports its map.");
        public async Task<byte[]> Generate(ImageGenerationRequest image, CancellationToken ct)
        {
            Interlocked.Increment(ref Calls);
            JsonFiles.Write(statePath + ".image-request", new { image.Prompt, image.Width, image.Height });
            while (!File.Exists(statePath + ".image-ready")) await Task.Delay(100, ct);
            return await File.ReadAllBytesAsync(sourceImage, ct);
        }
    }
    public static async Task Run(string statePath, string libraryRoot, string? resumeRoot = null, string? resumeUrl = null)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop")) throw new InvalidOperationException("Use a fresh fixture state path.");
        if (resumeRoot is not null && (!Path.GetFileName(Path.GetFullPath(resumeRoot)).StartsWith("dicerealm-tests-", StringComparison.Ordinal) ||
            !Path.GetDirectoryName(Path.GetFullPath(resumeRoot))!.Equals(Path.TrimEndingDirectorySeparator(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("Only owned temporary data may resume.");
        if (resumeUrl is not null && (resumeRoot is null || !Uri.TryCreate(resumeUrl, UriKind.Absolute, out var uri) || uri.Scheme != "http" || !uri.IsLoopback))
            throw new InvalidOperationException("Only the isolated loopback listener may resume.");
        var dice = new SequenceDice(10, 20);
        var images = new Images(statePath, Path.Combine(Path.GetFullPath(libraryRoot), "fixture-portrait.png"));
        var model = new Model(async (_, request, ct) =>
        {
            var frame = HarnessExecutionProtocolTests.Frame(request);
            var self = frame.GetProperty("self"); string actor = self.GetProperty("actorId").GetString()!, name = self.GetProperty("name").GetString()!;
            var board = frame.GetProperty("board").GetProperty("state"); string map = board.GetProperty("map").GetProperty("id").GetString()!;
            bool opening = request.Tools.Any(t => t.Name == "opening_commit");
            if (opening)
            {
                if (!board.GetProperty("tokens").EnumerateArray().Any(t => t.GetProperty("actorId").GetString() == actor))
                    return Tool("token_spawn", new { mapId = map, spawns = new[] { new { existingId = "", kind = "creature", source = new { kind = "player", id = actor }, appearance = new { name }, x = 1.5 / 12, y = 2.5 / 8, actorId = actor } } });
                return Tool("opening_commit", new OpeningNarrativeArgs(frame.GetProperty("opening").GetProperty("writePublic").GetBoolean()
                    ? name + "来到道路边缘，四周的灌木被微风吹动。" : "", "你停下脚步，观察周围的道路。"));
            }
            if (!request.Messages.Any(m => m.Name == "encounter_prepare"))
                return Tool("encounter_prepare", new HarnessEncounterPrepare(map, "portrait-ambush", "隔离验收：灌木后有一名地精伏兵。",
                    "隔离DM使用六十四像素战术方格。", new(64, 0, 0),
                    [new("xmm:goblin-warrior", "地精伏兵 C", "ranged", 5.5 / 12, 2.5 / 8, "three-quarters-cover", "伏兵藏在灌木后，脱离角色视线。")],
                    [new(3, 1, "three-quarters-cover"), new(3, 2, "three-quarters-cover"), new(3, 3, "three-quarters-cover")]));
            if (!request.Messages.Any(m => m.Name == "check_request"))
                return Tool("check_request", new HarnessCheckArgs("wisdom", "Perception", "normal", "portrait-ambush", "隔离验收：灌木后有一名地精伏兵。",
                    EncounterId: Regex.Match(string.Join("\n", request.Messages.Select(m => m.Content)), @"runtime-[0-9a-f-]{36}").Value));
            File.WriteAllText(statePath + ".narrative-waiting", "waiting for isolated fake narration");
            while (!File.Exists(statePath + ".narrative-ready")) await Task.Delay(100, ct);
            return Tool("world_record", new NarrativeHarnessArgs(name + "凝神望向路边的灌木，枝叶在风中轻响。", [],
                Private: "你辨认出灌木后的地精伏兵 C。它握着一张短弓，正盯着道路。"));
        });
        await using var h = await Host.Start(root: resumeRoot, dice: dice, images: images, configure: Configure(model, extra: b =>
        {
            if (resumeUrl is not null) b.WebHost.UseUrls(resumeUrl);
            b.Configuration["AdventureLibrary:Directory"] = Path.GetFullPath(libraryRoot);
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        }));
        if (resumeRoot is null) AccountTests.SeedAdminFixture(h);
        JsonFiles.Write(statePath, new { baseUrl = h.Http.BaseAddress!.GetLeftPart(UriPartial.Authority), dataPath = h.Root,
            processId = Environment.ProcessId, fixture = "portrait-reveal-real-pi-fake-provider", resumed = resumeRoot is not null });
        object Stats() => new { dice = dice.Count, modelCalls = model.Calls, images = images.Calls, paidProviderCalls = 0 };
        while (!File.Exists(statePath + ".stop"))
        {
            // The external QA reader may briefly hold this diagnostic file without delete sharing on Windows.
            try { JsonFiles.Write(statePath + ".stats", Stats()); }
            catch (IOException) { } catch (UnauthorizedAccessException) { }
            await Task.Delay(250);
        }
        JsonFiles.Write(statePath + ".result", Stats());
    }
}
