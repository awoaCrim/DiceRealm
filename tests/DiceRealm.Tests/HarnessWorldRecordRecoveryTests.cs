using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;
using static DiceRealm.Tests.HarnessExecutionProtocolTests;

namespace DiceRealm.Tests;

internal static class HarnessWorldRecordRecoveryTests
{
    private static HarnessModelReply Record(string id, string scene = "harbor") => Tool("world_record",
        new NarrativeHarnessArgs("公开测试叙事。", [new(id, "clue", "修正后的公开线索", "测试发现，不授予机械效果。", "known", scene)]));

    public static Task RejectedProposalIsAtomicAndRepairable() => Recovery(false);
    public static Task RealPiRepairsWithoutRepeatingAction() => Recovery(true);

    private static async Task Recovery(bool pi)
    {
        string path = ""; byte[] before = []; int version = 0; Exception? modelFailure = null;
        byte[] DatabaseBytes()
        {
            // Concurrent read-only GETs open SQLite read/write on Windows. This read
            // must not deny their existing write share while comparing unchanged bytes.
            using var file = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var copy = new MemoryStream(); file.CopyTo(copy); return copy.ToArray();
        }
        void Rejected(HarnessModelRequest request)
        {
            var result = request.Messages.Last(m => m.Role == "tool");
            Check.True(result.IsError == true);
            using var doc = JsonDocument.Parse(result.Content);
            var root = doc.RootElement;
            Check.Equal("invalid_world_memory", root.GetProperty("code").GetString());
            Check.True(!root.GetProperty("protocol").GetProperty("applied").GetBoolean());
            Check.Equal("model", root.GetProperty("protocol").GetProperty("next").GetString());
            Check.Equal(version, root.GetProperty("protocol").GetProperty("version").GetInt32());
            Check.Equal(version, Frame(request).GetProperty("version").GetInt32());
            Check.True(before.SequenceEqual(DatabaseBytes()), "Rejected proposal must leave state, roots, events, world rows and receipts byte-identical");
        }
        var model = new Model((call, request) =>
        {
            try
            {
            switch (call)
            {
                case 1:
                    version = Frame(request).GetProperty("version").GetInt32();
                    before = DatabaseBytes();
                    string description = request.Tools.Single(t => t.Name == "world_record").InputSchema.GetProperty("properties")
                        .GetProperty("memory").GetProperty("items").GetProperty("properties").GetProperty("id").GetProperty("description").GetString()!;
                    Check.True(description.Contains("Never invent an ID", StringComparison.Ordinal));
                    return Record("invented-clue-id"); // no root exists yet: rejected HarnessRoot must roll back too
                case 2:
                    Rejected(request);
                    return Tool("actions_propose", new { candidateId = Choice(request, "观察") });
                case 3:
                    version = Frame(request).GetProperty("version").GetInt32();
                    before = DatabaseBytes();
                    return Record("another-invented-id");
                case 4:
                    Rejected(request);
                    return Record("", "unknown-scene"); // repair feedback must not grant unknown scene authority
                case 5:
                    Rejected(request);
                    return Record("");
                case 6:
                    Check.True(request.Messages.Last(m => m.Role == "tool").IsError != true);
                    return Text("公开测试叙事。线索已保存。");
                default: throw new Exception("Unexpected model call " + call);
            }
            }
            catch (Exception error) { modelFailure = error; throw; }
        });
        var dice = new SequenceDice();
        var configure = Configure(model, extra: b =>
        {
            if (pi) { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); }
        });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(h);
            path = Path.Combine(h.Root, "campaigns", owner.Snapshot.Id + ".sqlite");
            var request = new HarnessInputRequest(Id(), owner.Snapshot.Version, "观察并保存公开线索");
            var run = await Post<HarnessRunView>(h, owner.Snapshot.Id, "harness/runs", request);
            run = await Settled(h, owner.Snapshot.Id, run.Id, 3000);
            Check.True(run.Status == "completed", run.Status + "/" + run.Error + " " + modelFailure);
            Check.Equal(5, model.Calls); Check.Equal(0, dice.Count);
            Check.Equal("公开测试叙事。", run.Text);
            var snapshot = (await h.Get(owner.Snapshot.Id))!;
            Check.Equal(1, snapshot.Events.Count(e => e.Kind == "observe"));
            var memory = snapshot.WorldMemory!.Single(m => m.Name == "修正后的公开线索");
            Check.True(Guid.TryParse(memory.Id, out _)); Check.Equal(1, memory.Revision);
            var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{snapshot.Id}/activity"))!;
            Check.Equal(1, activity.Entries.Length); Check.Equal(run.Text, activity.Entries[0].Narrative);
            var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(snapshot.Id, PartyEngine.HostId, run.Id)!;
            var refused = saved.Steps.Where(s => s.ToolName == "world_record" && s.Outcome?.Reply.IsError == true).ToArray();
            Check.Equal(3, refused.Length);
            Check.True(refused.All(s => s.Status == "done" && s.Outcome!.Reply.Stop == false));
            string original = HarnessJson.Serialize(saved); byte[] database = File.ReadAllBytes(path);
            Check.True((await Post<HarnessRunView>(h, snapshot.Id, "harness/runs", request)).Replayed);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<HarnessRunView>(h, snapshot.Id, "harness/runs", request)).Replayed);
            Check.Equal(5, model.Calls); Check.Equal(0, dice.Count);
            Check.True(database.SequenceEqual(File.ReadAllBytes(path)));
            Check.Equal(original, HarnessJson.Serialize(h.App.Services.GetRequiredService<HarnessRunStore>().Read(snapshot.Id, PartyEngine.HostId, run.Id)!));
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task HistoricalV16StillFailsAndGameGateStaysStrict()
    {
        var model = new Model((_, _) => Record("invented-clue-id"));
        await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h);
        var game = h.App.Services.GetRequiredService<GameService>();
        var auth = await game.AuthorizeHarness(owner.Snapshot.Id, owner.AccessToken, default);
        var request = new HarnessInputRequest(Id(), auth.Version, "旧合同提议");
        var context = await game.ValidateHarnessStart(owner.Snapshot.Id, owner.AccessToken, auth.Version, default, request.Text);
        // A persisted old run fixture, not a production downgrade option.
        var fixture = new HarnessRun
        {
            Id = request.RequestId, IntentId = Id(), CampaignId = owner.Snapshot.Id, ActorId = auth.ActorId,
            Fingerprint = HarnessJson.Fingerprint(HarnessJson.Element(request)), Input = request.Text,
            Profile = context.Profile, MemorySnapshot = context.Memory, Version = auth.Version,
            ToolContractVersion = 16, RulesCatalogVersion = context.RulesCatalogVersion, Limits = new(),
            Turns = [HarnessJson.Serialize(new { input = request.Text, ruleset = "dnd2024", memory = context.Memory })]
        };
        h.App.Services.GetRequiredService<HarnessRunStore>().Create(fixture);
        string path = Path.Combine(h.Root, "campaigns", owner.Snapshot.Id + ".sqlite"); byte[] before = File.ReadAllBytes(path);
        await Post<HarnessRunView>(h, owner.Snapshot.Id, $"harness/runs/{fixture.Id}/resume", new HarnessResumeRequest(Id(), auth.Version));
        var run = await Settled(h, owner.Snapshot.Id, fixture.Id);
        Check.Equal("failed", run.Status); Check.Equal("invalid_world_memory", run.Error); Check.Equal(1, model.Calls);
        Check.True(before.SequenceEqual(File.ReadAllBytes(path)));
        foreach (var (token, version, code) in new[]
        {
            (owner.AccessToken, auth.Version, "invalid_world_memory"),
            (owner.AccessToken, auth.Version - 1, "stale_version"),
            (new string('0', 64), auth.Version, "unauthorized")
        })
        {
            try
            {
                await game.HarnessTool(owner.Snapshot.Id, token, auth.ActorId, Id(), "严格校验", version, Id(), "strict-world-record",
                    new("world_record", Record("invented-clue-id").ToolCalls[0].Arguments, "strict"), [], default, auth.Profile, 17, true, []);
                throw new Exception("Expected strict game-gate rejection");
            }
            catch (GameException error) { Check.Equal(code, error.Code); }
            Check.True(before.SequenceEqual(File.ReadAllBytes(path)));
        }
    }
}
