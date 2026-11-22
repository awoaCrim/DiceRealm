using System.Net;
using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class AdventureOpeningTests
{
    private static AdventureDocument Document => new()
    {
        Id = "opening-fixture", Version = "1", Name = "开场隔离夹具", StartSceneId = "main",
        Opening = new("main", ["far", "near"]),
        Scenes = [
            new() { Id = "main", Title = "主线入口", Summary = "未接受的委托所在地", Arrival = "前方是通往山谷的道路。" },
            new() { Id = "far", Title = "远处驿站", Arrival = "远处驿站公共厅。", SafeRest = true, Exits = [new("main", new(), 600)] },
            new() { Id = "near", Title = "附近旅店", Summary = "旅店公共厅，老板正在柜台后接待客人。", Arrival = "旅店公共厅里，老板站在柜台后。门外通向山谷的道路上行人不多。老板正询问是否有人愿意听一件委托。", SafeRest = true, Exits = [new("main", new(), 60)] }
        ],
        InitialKnowledge = [new("secret", "clue", "主持秘密", "HOST_OPENING_SECRET", "near", "host")]
    };
    public static async Task NearestPlaceOneSharedOpeningAndPrivateEntry()
    {
        var model = new Model((call, request) =>
        {
            Check.Equal(Preset.SystemPrompt, request.System);
            Check.True(request.Tools.Any(t => t.Name == "opening_commit"));
            Check.True(request.Tools.All(t => HarnessOpenings.Allows(t.Name, HarnessTools.CurrentVersion)));
            string payload = string.Join("\n", request.Messages.Select(m => m.Content));
            Check.True(payload.Contains("writePublic") && !payload.Contains("HOST_OPENING_SECRET"));
            if (call == 1) return Tool("opening_commit", new OpeningNarrativeArgs("旅店公共厅里，老板抬头询问来客是否愿意听一件委托。", "你记得约见的口信，但尚未答应任何委托。"));
            Check.True(payload.Contains("老板抬头") && !payload.Contains("你记得约见的口信"));
            return Tool("opening_commit", new OpeningNarrativeArgs("", ""));
        });
        var dice = new SequenceDice();
        var h = await Host.Start(dice: dice, configure: Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        }));
        try
        {
            var owner = await Create(h, Document); string id = owner.Snapshot.Id;
            Check.Equal("near", owner.Snapshot.Scene.Id); Check.True(owner.Snapshot.Opening!.Needed);
            var guest = await HarnessBoundaryTests.Guest(h, owner);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var before = (await h.Get(id))!;
            Check.Equal(0, model.Calls); // create, approve and GET do not generate
            var request = new StartOpeningRequest(Id(), before.Version);
            var accepted = await Post<AdventureSessionView>(h, id, "adventure/opening", request);
            var run = await Settled(h, id, accepted.SessionId, 3000);
            Check.True(run.Status == "completed", run.Status + "/" + run.Error + "; calls=" + model.Calls + "; tools=" + string.Join(',', model.Requests.LastOrDefault()?.Tools.Select(t => t.Name) ?? []) + "; secret=" + HarnessJson.Serialize(model.Requests).Contains("HOST_OPENING_SECRET")); Check.True(run.Opening);
            var after = (await h.Get(id))!;
            Check.Equal(before.Version + 1, after.Version); Check.Equal("near", after.Scene.Id);
            Check.Equal(before.ElapsedSeconds, after.ElapsedSeconds); Check.Equal(0, dice.Count);
            Check.Equal(HarnessJson.Serialize(before.Facts), HarnessJson.Serialize(after.Facts));
            Check.Equal(HarnessJson.Serialize(before.Character), HarnessJson.Serialize(after.Character));
            Check.True(!after.Opening!.Needed); Check.Equal(1, after.Opening.PrivateParts.Length);
            Check.True(!accepted.ActionText.Any());
            var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity?after=0&limit=100"))!;
            Check.True(activity.Entries.All(e => e.Kind != "story.opening"), "Opening is not a player action root");
            Check.True((await Post<AdventureSessionView>(h, id, "adventure/opening", request)).Replayed);
            Check.Equal(1, model.Calls);
            // A later entrant sees the current place, not a replay or teleport to the inn.
            await h.Act(after, "travel", "main");
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var guestBefore = (await h.Get(id))!;
            Check.Equal("main", guestBefore.Scene.Id);
            Check.True(guestBefore.Opening!.Needed); Check.Equal(0, guestBefore.Opening.PrivateParts.Length);
            Check.True(!HarnessJson.Serialize(guestBefore).Contains("你记得约见的口信"));
            var next = new StartOpeningRequest(Id(), guestBefore.Version);
            var guestRun = await Post<AdventureSessionView>(h, id, "adventure/opening", next);
            Check.Equal("completed", (await Settled(h, id, guestRun.SessionId, 3000)).Status);
            var guestAfter = (await h.Get(id))!;
            Check.Equal(after.Opening.PublicText, guestAfter.Opening!.PublicText);
            Check.Equal(after.Opening.PublicSequence, guestAfter.Opening.PublicSequence);
            Check.True(!guestAfter.Opening.Needed); Check.Equal(0, guestAfter.Opening.PrivateParts.Length);
            Check.Equal(2, model.Calls);
            // Ordinary state and each model frame remain isolated from the other actor's supplement.
            var game = h.App.Services.GetRequiredService<GameService>();
            var auth = await game.AuthorizeHarness(id, guest.AccessToken, default);
            var frame = await game.ReadHarnessExecution(id, guest.AccessToken, auth.ActorId, Id(), "询问委托", guestAfter.Version, default, 38);
            Check.True(frame.Opening is { Generating: false, PrivateText: "" });
            Check.True(!frame.AvailableTools.Contains("opening_commit"));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var share = await Post<ActionResponse>(h, id, "adventure/story/share", new SharePrivateStoryRequest(Id(), after.Opening.PrivateParts[0].Source));
            Check.Equal(after.Opening.PrivateParts[0].Text, share.SharedStory!.Text);
            string root = h.Root; await h.DisposeAsync();
            h = await Host.Start(root, configure: Configure(model, extra: b => b.Configuration["Harness:Enabled"] = "false"));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<AdventureSessionView>(h, id, "adventure/opening", request)).Replayed);
            Check.Equal(2, model.Calls);
            Check.Equal(after.Opening.PublicText, (await h.Get(id))!.Opening!.PublicText);
        }
        finally { await h.DisposeAsync(); }
    }
    public static async Task FailedOpeningIsDiscoverableWithoutAutomaticRetry()
    {
        var model = new Model((_, _) => Text("没有使用开场提交工具。"));
        var h = await Host.Start(configure: Configure(model));
        try
        {
            var owner = await Create(h, Document); var request = new StartOpeningRequest(Id(), owner.Snapshot.Version);
            var accepted = await Post<AdventureSessionView>(h, owner.Snapshot.Id, "adventure/opening", request);
            var run = await Settled(h, owner.Snapshot.Id, accepted.SessionId);
            Check.Equal("failed", run.Status); Check.Equal("opening_commit_required", run.Error);
            Check.True((await h.Get(owner.Snapshot.Id))!.Opening!.Needed); Check.Equal(1, model.Calls);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: Configure(model));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var board = (await h.Http.GetFromJsonAsync<AdventureBoard>($"/api/v1/campaigns/{owner.Snapshot.Id}/adventure"))!;
            Check.True(board.Sessions.Single().Opening); Check.Equal("failed", board.Sessions.Single().Phase);
            Check.True((await Post<AdventureSessionView>(h, owner.Snapshot.Id, "adventure/opening", request)).Replayed);
            Check.Equal(1, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }
    public static async Task OpeningCannotExecuteActionsOrRewritePublic()
    {
        var model = new Model((_, _) => throw new Exception("Direct boundary tests never call model"));
        await using var h = await Host.Start(configure: Configure(model));
        var owner = await Create(h, Document); string id = owner.Snapshot.Id;
        var guest = await HarnessBoundaryTests.Guest(h, owner);
        var game = h.App.Services.GetRequiredService<GameService>();
        async Task<HarnessToolOutcome> Call(string token, string name, object args, bool opening = true, int contract = 38)
        {
            var auth = await game.AuthorizeHarness(id, token, default);
            return await game.HarnessTool(id, token, auth.ActorId, Id(), HarnessOpenings.Input, auth.Version, Id(), Id(),
                new(name, HarnessJson.Element(args), "fixture"), [], default, auth.Profile, contract, contextAlreadyRead: true, opening: opening);
        }
        async Task Reject(Func<Task> operation)
        { try { await operation(); throw new Exception("Expected rejection"); } catch (GameException e) { Check.True(e.Code is "harness_tool_unavailable" or "harness_invalid_payload" or "opening_completed"); } }
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var before = (await h.Get(id))!;
        var travel = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/actions", new ActionRequest(Id(), before.Version, "travel", "main", ""));
        Check.Equal(HttpStatusCode.Conflict, travel.StatusCode);
        Check.True((await travel.Content.ReadAsStringAsync()).Contains("opening_required"));
        Check.Equal(before.Version, (await h.Get(id))!.Version);
        await Reject(() => Call(owner.AccessToken, "world_record", new NarrativeHarnessArgs("假装已经答应", [])));
        await Reject(() => Call(owner.AccessToken, "opening_commit", new OpeningNarrativeArgs("现场", ""), opening: false));
        await Call(owner.AccessToken, "opening_commit", new OpeningNarrativeArgs("共同现场", "本人私密"));
        await Reject(() => Call(owner.AccessToken, "opening_commit", new OpeningNarrativeArgs("重写", "")));
        await Reject(() => Call(guest.AccessToken, "opening_commit", new OpeningNarrativeArgs("再次出场", "")));
        // v58: a later entrant's own short arrival is public; the saved shared opening stays as it was.
        await Reject(() => Call(guest.AccessToken, "opening_commit", new OpeningNarrativeArgs(new string('雨', HarnessOpenings.ArrivalMaximum + 1), ""), contract: 58));
        await Call(guest.AccessToken, "opening_commit", new OpeningNarrativeArgs("另一位旅人推门进来，抖落斗篷上的雨水。", ""), contract: 58);
        var arrived = (await h.Get(id))!;
        Check.Equal("共同现场", arrived.Opening!.PublicText);
        Check.True(arrived.Events.Any(e => e.Kind == "story.opening" && e.Text == "另一位旅人推门进来，抖落斗篷上的雨水。"));
        Check.Equal("另一位旅人推门进来，抖落斗篷上的雨水。", arrived.Opening.Arrivals!.Single().Text);
        var legacy = game.Create(new CreateCampaignRequest("旧引擎显式开局配置", "旧玩家", Adventure: Document, Prompts: TestContent.Prompts, StartImmediately: true, Build: FullCreationTests.Named("旧玩家")));
        Check.True(legacy.Snapshot.Opening is null, "Legacy content must not wait for an unavailable Harness opening");
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", legacy.AccessToken);
        Check.Equal("main", (await h.Act(legacy.Snapshot, "travel", "main")).Snapshot.Scene.Id);
        Check.Equal(0, model.Calls);
        var wrong = Document with { Opening = new("main", ["far"]) };
        Check.Equal("far", AdventureOpenings.SelectScene(wrong));
        var tied = Document with { Scenes = Document.Scenes.Select(s => s.Id == "far" ? s with { Exits = [new("main", new(), 60)] } : s).ToArray() };
        Check.Equal("far", AdventureOpenings.SelectScene(tied));
        Check.Equal(Document.StartSceneId, AdventureOpenings.SelectScene(Document with { Opening = null }));
        var blocked = Document with { Scenes = Document.Scenes.Select(s => s with { Exits = [] }).ToArray() };
        try { ContentValidator.Validate(blocked); throw new Exception("Disconnected opening accepted"); }
        catch (GameException e) { Check.Equal("invalid_content", e.Code); }
    }
}
