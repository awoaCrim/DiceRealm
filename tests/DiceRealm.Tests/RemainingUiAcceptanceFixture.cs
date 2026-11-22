using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

// Opt-in Mac UI fixture: real HTTP and persistence, synthetic ended history, no suppliers.
// DICEREALM_QA_KEYBOARD_FIXED_MODEL=1 additionally enables explicit synthetic keyboard replies.
// HTTP-created/advanced characters are setup evidence, never full creation/level-up UI acceptance.
internal static class RemainingUiAcceptanceFixture
{
    private sealed class RefusingText : IIntentInterpreter, INarrator
    {
        public int Calls;
        public Task<Intent?> Interpret(string text, ActionChoice[] allowed, CancellationToken ct, string campaignId = "", PromptBundle? prompts = null)
        { Interlocked.Increment(ref Calls); throw new InvalidOperationException("UI fixture forbids text generation."); }
        public Task<Narrative> Narrate(NarrativeContext context, CancellationToken ct, string campaignId = "", PromptBundle? prompts = null)
        { Interlocked.Increment(ref Calls); throw new InvalidOperationException("UI fixture forbids narration generation."); }
    }

    private sealed class RefusingHttp(Action attempted) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        { attempted(); throw new InvalidOperationException("UI fixture forbids outbound provider HTTP."); }
    }

    public static async Task Run(string statePath)
    {
        statePath = Path.GetFullPath(statePath);
        foreach (string suffix in new[] { "", ".stop", ".stats", ".result", ".connection.json", ".guest.json" })
            if (File.Exists(statePath + suffix)) throw new InvalidOperationException("Use a fresh fixture state path.");
        string root = Path.Combine(Path.GetTempPath(), "dicerealm-remaining-ui-" + Guid.NewGuid());
        var dice = new SequenceDice(2, 3, 2, 3, 2, 3);
        var text = new RefusingText();
        int outboundAttempts = 0;
        bool keyboardMode = Environment.GetEnvironmentVariable("DICEREALM_QA_KEYBOARD_FIXED_MODEL") == "1";
        var keyboardInputs = new System.Collections.Concurrent.ConcurrentQueue<string>();
        var model = new HarnessTests.Model(async (_, request, ct) =>
        {
            if (!keyboardMode) throw new InvalidOperationException("UI fixture forbids model generation.");
            var frame = HarnessExecutionProtocolTests.Frame(request);
            if (request.Tools.Any(t => t.Name == "opening_commit"))
                return HarnessTests.Tool("opening_commit", new OpeningNarrativeArgs(
                    "[固定模型键盘QA开场] 仅验证输入与HTTP，不代表真实模型质量。", ""));
            string input = frame.GetProperty("context").GetProperty("intent").GetProperty("text").GetString()!;
            keyboardInputs.Enqueue(input);
            // Keep the genuine pending interval observable for repeated-key checks.
            await Task.Delay(5000, ct);
            return HarnessTests.Tool("world_record", new NarrativeHarnessArgs(
                "[固定模型键盘QA回应] 收到：" + input, []));
        });
        await using var host = await Host.Start(root, dice, interpreter: text, narrator: text,
            configure: HarnessTests.Configure(model, extra: b =>
            {
                foreach (string prefix in new[] { "TextAi", "ImageAi", "HarnessAi", "PreparationAi" })
                { b.Configuration[prefix + ":ApiKey"] = ""; b.Configuration[prefix + ":Model"] = ""; }
                b.Services.AddSingleton<IPreparationGenerator, OfflinePreparation>();
                b.Services.ConfigureHttpClientDefaults(http => http.ConfigurePrimaryHttpMessageHandler(
                    () => new RefusingHttp(() => Interlocked.Increment(ref outboundAttempts))));
            }));
        AccountTests.SeedAdminFixture(host);
        // Reuse the existing qualified wizard/fighter progression fixture and production commands.
        var build = FullCreationTests.Complete("wizard", "human", "sage") with
        {
            Identity = new() { Name = "[QA] 埃兰 · Arden" },
            BaseScores = [13, 12, 14, 15, 10, 8], BackgroundBonuses = [0, 0, 0, 2, 1, 0]
        };
        var response = keyboardMode
            ? await host.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest(
                "[隔离固定模型QA] 非空键盘发送", build.Identity.Name, TestContent.Document, HarnessTests.Preset, Build: build))
            : await host.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest(
            "[隔离合成QA] 剩余界面补验", build.Identity.Name, Adventure: TestContent.Document,
            Prompts: TestContent.Prompts, StartImmediately: true, Build: build));
        Check.Equal(HttpStatusCode.Created, response.StatusCode);
        var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        string path = "/api/v1/campaigns/" + owner.Snapshot.Id;
        var s = owner.Snapshot;
        s = (await Post(host, path + "/characters/advancement/award", new AwardAdvancementRequest(
            Id(), s.Version, PartyEngine.HostId, "milestone", 3, "隔离QA：允许三级成长"))).Snapshot;
        foreach (string cls in new[] { "wizard", "fighter" })
            s = (await Post(host, path + "/character/advancement/apply", new ApplyAdvancementRequest(
                Id(), s.Version, AdvancementTests.Complete(s.Character.Required(), cls)))).Snapshot;
        string invite = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        response = await host.Http.PostAsJsonAsync(path + "/invitations", new InviteRequest(Id(), s.Version, invite));
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        response = await host.Http.PostAsJsonAsync(path + "/join", new JoinCampaignRequest(Id(), invite,
            Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)), "[QA] 莉雅 · Lyra", CharacterEngine.Fighter,
            Build: FullCreationTests.Named("[QA] 莉雅 · Lyra")));
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        var guest = await host.ApproveGuest(owner, (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!);
        foreach (string actor in new[] { PartyEngine.HostId, guest.Snapshot.Party!.SelfActorId })
        {
            s = (await host.Get(s.Id))!;
            s = (await Post(host, path + "/characters/adjust", new AdjustCharacterRequest(Id(), s.Version,
                actor, "隔离QA伤势", "仅用于本人恢复边界补验", [new CharacterAdjustment("hp", "", 1)]))).Snapshot;
        }
        // Only this new room receives authored synthetic, already-ended long entries.
        // No Harness runs, model replies, token usage or real 65-round history are fabricated.
        await host.App.Services.GetRequiredService<CampaignStore>().Access(s.Id, owner.AccessToken, true, c =>
        {
            for (int i = 1; i <= 130; i++)
            {
                string input = $"[合成已结束QA {i:000}/130] 翻阅第{i}页旅途记录；此输入仅供分页与滚动补验。";
                string narrative = string.Join("\n\n", Enumerable.Range(1, 4).Select(n =>
                    $"[合成已结束QA {i:000} 段{n}] 这是一段人工编写的界面负载样本。队伍沿河岸整理旧记录，远处的灯塔照着码头；本条没有待处理行动，没有真实模型回复，也不代表一次真实游戏轮次。"));
                var resolution = new Resolution("resolved", "observe", "[合成已结束QA] 已整理记录，无机械变化。", null, []);
                c.Events.Add(new(Id(), ++c.Version, "observe", input, narrative, "authored", DateTimeOffset.UtcNow,
                    resolution, Origin: new(input, "合成QA记录", "observe", "", c.Character!.Name,
                        c.SceneId, Adventure.Current(c).Title, [])));
            }
            return Task.FromResult(true);
        });
        s = (await host.Get(s.Id))!;
        Check.True(s.PendingIntent is null && s.PendingRoll is null, "Fixture must start without unfinished input.");
        int initialVersion = s.Version;
        string address = host.Http.BaseAddress!.GetLeftPart(UriPartial.Authority);
        WriteConnection(statePath + ".connection.json", address, s.Id, owner.AccessToken);
        WriteConnection(statePath + ".guest.json", address, s.Id, guest.AccessToken);
        JsonFiles.Write(statePath, new { baseUrl = address, dataPath = root, processId = Environment.ProcessId,
            campaignId = s.Id, initialVersion, guestActorId = guest.Snapshot.Party!.SelfActorId,
            fixture = keyboardMode ? "remaining-ui-keyboard-fixed-model-no-providers" : "remaining-ui-synthetic-ended-history-no-providers", syntheticEntries = 130 });
        object Stats(int version) => new { initialVersion, finalVersion = version, diceCount = dice.Count,
            modelCalls = model.Calls + text.Calls, outboundAttempts, providers = "disabled", syntheticEntries = 130, keyboardMode, keyboardInputs = keyboardInputs.ToArray() };
        Console.WriteLine(keyboardMode
            ? "Remaining UI fixture ready; opt-in FIXED SYNTHETIC keyboard replies, providers disabled."
            : "Remaining UI fixture ready; synthetic history, HTTP-created characters, providers disabled.");
        while (!File.Exists(statePath + ".stop"))
        {
            JsonFiles.Write(statePath + ".stats", Stats((await host.Get(s.Id))!.Version));
            await Task.Delay(250);
        }
        JsonFiles.Write(statePath + ".result", Stats((await host.Get(s.Id))!.Version));
        if (!keyboardMode) Check.Equal(0, model.Calls);
        Check.Equal(0, text.Calls);
        Check.Equal(0, outboundAttempts);
    }

    private static string Id() => Guid.NewGuid().ToString();
    private static async Task<ActionResponse> Post<T>(Host h, string path, T body)
    {
        var response = await h.Http.PostAsJsonAsync(path, body);
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<ActionResponse>())!;
    }
    private static void WriteConnection(string path, string address, string id, string token)
    {
        JsonFiles.Write(path, new { baseUrl = address, campaignId = id, accessToken = token });
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
}
