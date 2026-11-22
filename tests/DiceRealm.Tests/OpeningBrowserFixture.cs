using System.Text.RegularExpressions;
using DiceRealm.Server.Application;
using DiceRealm.Server.Infrastructure;
using System.Text.Json;
using DiceRealm.Server.Domain;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.AspNetCore.Hosting;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

// Opt-in real dual-client acceptance; empty isolated database, real Pi, counted fake text only.
internal static class OpeningBrowserFixture
{
    public static async Task Run(string statePath, string libraryRoot, string? resumeRoot = null, bool positionAndRolls = false, string? resumeUrl = null)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop")) throw new InvalidOperationException("Use a fresh fixture path.");
        if (resumeRoot is not null && (!Path.GetFileName(Path.GetFullPath(resumeRoot)).StartsWith("dicerealm-tests-", StringComparison.Ordinal) ||
            !Path.GetDirectoryName(Path.GetFullPath(resumeRoot))!.Equals(Path.TrimEndingDirectorySeparator(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("Only the owned temporary fixture can resume.");
        if (resumeUrl is not null && (resumeRoot is null || !Uri.TryCreate(resumeUrl, UriKind.Absolute, out var address) || address.Scheme != "http" || !address.IsLoopback))
            throw new InvalidOperationException("Resume URLs must be local HTTP fixture listeners.");
        var dice = new SequenceDice();
        var model = new Model((_, request) =>
        {
            if (positionAndRolls) return PositionAndRolls(request);
            if (!request.Tools.Any(t => t.Name == "opening_commit")) throw new InvalidOperationException("Only entry generation is allowed in this fixture.");
            bool first = request.Messages.Any(m => Regex.IsMatch(m.Content, "\"writePublic\"\\s*:\\s*true"));
            return Tool("opening_commit", new OpeningNarrativeArgs(first ?
                "石丘旅店的公共厅里，镇民围坐交谈。老板托布伦·石丘在柜台后抬起头，向进门的旅客问候：‘欢迎。需要歇歇脚吗？’门边留着通往街道的空隙，炉边还有空座。" : "",
                "你尚未答应任何委托。眼前的交谈可以由你自行回应，也可以先留意旅店里的动静。"));
        });
        await using var h = await Host.Start(root: resumeRoot, dice: dice, configure: Configure(model, extra: b =>
        {
            if (resumeUrl is not null) b.WebHost.UseUrls(resumeUrl);
            b.Configuration["AdventureLibrary:Directory"] = Path.GetFullPath(libraryRoot);
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        }));
        if (resumeRoot is null) AccountTests.SeedAdminFixture(h);
        JsonFiles.Write(statePath, new { baseUrl = h.Http.BaseAddress!.GetLeftPart(UriPartial.Authority), dataPath = h.Root,
            processId = Environment.ProcessId, fixture = "opening-real-pi-fake-model", resumed = resumeRoot is not null });
        Console.WriteLine("Opening fixture ready: no rooms/characters seeded; real Pi and fake model only.");
        while (!File.Exists(statePath + ".stop"))
        {
            JsonFiles.Write(statePath + ".stats", new { dice = dice.Count, modelCalls = model.Calls, paidProviderCalls = 0 });
            await Task.Delay(500);
        }
        JsonFiles.Write(statePath + ".result", new { dice = dice.Count, modelCalls = model.Calls, paidProviderCalls = 0 });
    }

    // Explicit fake replies for native UI acceptance. No generated dice or direct state patches.
    private static HarnessModelReply PositionAndRolls(HarnessModelRequest request)
    {
        var frame = HarnessExecutionProtocolTests.Frame(request);
        var self = frame.GetProperty("self");
        string actor = self.GetProperty("actorId").GetString()!, name = self.GetProperty("name").GetString()!;
        var state = frame.GetProperty("board").GetProperty("state");
        bool hasMap = state.ValueKind == JsonValueKind.Object;
        bool opening = request.Tools.Any(t => t.Name == "opening_commit");
        var token = hasMap ? state.GetProperty("tokens").EnumerateArray().FirstOrDefault(t => t.GetProperty("actorId").GetString() == actor && t.GetProperty("onMap").GetBoolean()) : default;
        string map = hasMap ? state.GetProperty("map").GetProperty("id").GetString()! : "";
        if (hasMap && token.ValueKind == JsonValueKind.Undefined && !request.Messages.Any(m => m.Name == "token_spawn"))
            return Tool("token_spawn", new { mapId = map, spawns = new[] { new { existingId = "", kind = "creature", source = new { kind = "player", id = actor }, appearance = new { name }, x = .22, y = .52, actorId = actor } } });
        if (opening)
            return Tool("opening_commit", new OpeningNarrativeArgs(frame.GetProperty("opening").GetProperty("writePublic").GetBoolean()
                ? name + "站在门旁，听着厅中交谈。窗边有人抬头向来客点了点头。" : "", "你想起了路上的雨声，尚未答应任何委托。"));
        string input = frame.GetProperty("context").GetProperty("intent").GetProperty("text").GetString()!;
        if (input.Contains("靠近", StringComparison.Ordinal))
        {
            if (!hasMap) throw new InvalidOperationException("Install the explicit test map before moving.");
            if (!request.Messages.Any(m => m.Name == "token_move"))
                return Tool("token_move", new { mapId = map, entityId = token.GetProperty("id").GetString(), destination = new { x = .6, y = .55 } });
            return Tool("world_record", new NarrativeHarnessArgs(name + "走到窗边停下。", [], Private: "你从窗边望见雨中的道路。"));
        }
        if (!request.Messages.Any(m => m.Name == "check_request"))
        {
            var scene = frame.GetProperty("scenePresentation");
            return Tool("check_request", new { ability = "wisdom", skill = "Perception", mode = "normal", sourceId = scene.GetProperty("sceneId").GetString()!, quote = scene.GetProperty("currentSummary").GetString()! });
        }
        return Tool("world_record", new NarrativeHarnessArgs(name + "留在门边，听见雨水沿着檐角落下。", [], Private: "你留意到窗沿积着水珠，屋内的灯光倒映其中。"));
    }
}
