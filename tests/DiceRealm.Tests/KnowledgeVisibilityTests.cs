using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

// Real campaign/HTTP projections; these fixtures never call a paid provider.
internal static class KnowledgeVisibilityTests
{
    private static void Auth(Host h, string token) => h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
    private static string Url(string id, string suffix = "") => $"/api/v1/campaigns/{id}{suffix}";
    private static async Task<JsonElement> Get(Host h, string id, string suffix = "") =>
        JsonDocument.Parse(await h.Http.GetStringAsync(Url(id, suffix))).RootElement.Clone();
    internal static object Message(string[] recipients, string text, params string[] discoveries) =>
        new { recipientIds = recipients, text, discoveryIds = discoveries };
    internal static object Story(string narrative, params object[] messages) =>
        new { narrative, memory = Array.Empty<object>(), privateMessages = messages };
    internal static async Task<HarnessToolOutcome> Record(Host h, CreatedCampaign seat, object payload, string input = "PRIVATE_ACTION_INPUT", string? intent = null, int contract = 43)
    {
        var game = h.App.Services.GetRequiredService<GameService>();
        var auth = await game.AuthorizeHarness(seat.Snapshot.Id, seat.AccessToken, default);
        return await game.HarnessTool(seat.Snapshot.Id, seat.AccessToken, auth.ActorId, intent ?? Id(), input,
            auth.Version, Id(), Id(), new("world_record", HarnessJson.Element(payload), "delivery"), [], default,
            auth.Profile, contract, contextAlreadyRead: true);
    }
    private static IEnumerable<JsonElement> Parts(JsonElement node)
    {
        if (node.ValueKind == JsonValueKind.Array)
            foreach (var child in node.EnumerateArray()) foreach (var part in Parts(child)) yield return part;
        if (node.ValueKind != JsonValueKind.Object) yield break;
        if (node.TryGetProperty("source", out var source) && source.ValueKind == JsonValueKind.Object &&
            source.TryGetProperty("revision", out _) && node.TryGetProperty("text", out _)) yield return node;
        foreach (var property in node.EnumerateObject()) foreach (var part in Parts(property.Value)) yield return part;
    }
    private static JsonElement Part(JsonElement node, string text) => Parts(node).First(p => p.GetProperty("text").GetString() == text);
    private static async Task<string> Body(Host h, CreatedCampaign seat, params string[] paths)
    {
        Auth(h, seat.AccessToken);
        var bodies = new List<string>();
        foreach (string path in paths) bodies.Add(await h.Http.GetStringAsync(Url(seat.Snapshot.Id, path)));
        return string.Join("\n", bodies);
    }
    private static async Task<JsonElement> Share(Host h, CreatedCampaign seat, object request)
    {
        Auth(h, seat.AccessToken);
        var response = await h.Http.PostAsJsonAsync(Url(seat.Snapshot.Id, "/adventure/story/share"), request);
        Check.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();
    }

    public static async Task ActualRecipientsAcrossEveryProjectionAndRestart()
    {
        const string privateBoth = "BC_KNOW_THE_BADGE", privateB = "B_ALONE_KNOWS_THE_PASSWORD", input = "A_PRIVATE_INPUT_NOT_FOR_RECIPIENTS";
        var model = new Model((_, _) => throw new Exception("Read-only checks must not call a model"));
        var h = await Host.Start(configure: Configure(model));
        try
        {
            var created = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new { name = "Four player privacy", adventure = TestContent.Document, preset = Preset });
            Check.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
            var owner = (await created.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            var a = await HarnessBoundaryTests.Guest(h, owner);
            var b = await HarnessBoundaryTests.Guest(h, owner); var c = await HarnessBoundaryTests.Guest(h, owner);
            var d = await HarnessBoundaryTests.Guest(h, owner); string id = owner.Snapshot.Id;
            string actorB = b.Snapshot.Party!.SelfActorId, actorC = c.Snapshot.Party!.SelfActorId;
            Auth(h, d.AccessToken); int before = (await h.Get(id))!.Version;
            try { await Record(h, a, Story("REJECTED_PUBLIC", Message([actorB, Id()], "INVALID_RECIPIENT_BODY"))); throw new Exception("Unknown recipient accepted"); }
            catch (GameException) { }
            Check.Equal(before, (await h.Get(id))!.Version);
            Check.True(!(await Body(h, owner, "")).Contains("REJECTED_PUBLIC"));
            var outcome = await Record(h, a, Story("", Message([actorB, actorC], privateBoth), Message([actorB], privateB)), input);
            Check.Equal("", outcome.CompletedNarrative);
            string[] paths = ["", "/events?after=0&limit=100", "/journal?after=0&limit=100", "/activity?after=0&limit=100"];
            async Task Verify()
            {
                foreach (var seat in new[] { a, d })
                {
                    string raw = await Body(h, seat, paths);
                    Check.True(!raw.Contains(privateBoth) && !raw.Contains(privateB), "Nonrecipient received private body");
                }
                foreach (var seat in new[] { b, c })
                {
                    foreach (string path in paths)
                    {
                        string raw = await Body(h, seat, path);
                        Check.True(raw.Contains(privateBoth), "Authorized recipient missed " + path);
                        Check.True(!raw.Contains(input), "Recipient received original private input via " + path);
                        Check.Equal(seat == b, raw.Contains(privateB));
                    }
                    Auth(h, seat.AccessToken);
                    var activity = await Get(h, id, "/activity?after=0&limit=100");
                    foreach (var entry in activity.GetProperty("entries").EnumerateArray().Where(e => e.GetRawText().Contains(privateBoth)))
                    {
                        var detail = await Get(h, id, "/activity/" + entry.GetProperty("sequence").GetInt32());
                        Check.True(detail.GetRawText().Contains(privateBoth) && !detail.GetRawText().Contains(input));
                        Check.True(Part(detail, privateBoth).GetProperty("canShare").GetBoolean());
                    }
                }
                string host = await Body(h, owner, paths);
                Check.True(host.Contains(privateBoth) && host.Contains(privateB));
                Check.True(!Part(await Get(h, id), privateBoth).GetProperty("canShare").GetBoolean(), "Host cannot publish a recipient's message");
                Check.True((await h.Http.GetStringAsync(Url(id, "/journal/export"))).Contains(privateBoth));
                Auth(h, d.AccessToken);
                var filtered = await Get(h, id, $"/activity?after={before}&limit=100");
                Check.Equal(0, filtered.GetProperty("entries").GetArrayLength());
                Check.True(filtered.GetProperty("nextAfter").GetInt32() > before && !filtered.GetProperty("hasMore").GetBoolean());
                var events = await Get(h, id, $"/events?after={before}&limit=100"); Check.Equal(0, events.GetArrayLength());
                Check.Equal(HttpStatusCode.Forbidden, (await h.Http.GetAsync(Url(id, "/journal/export"))).StatusCode);
            }
            await Verify();
            var empty = await Record(h, a, Story(""), "无新公开变化");
            Check.Equal("", empty.CompletedNarrative);
            await Verify();
            // A public phenomenon and one character's interpretation remain separate.
            await Record(h, a, Story("PUBLIC_VISIBLE_BADGE", Message([actorB], "B_RECOGNIZES_ITS_MEANING")), "看见守卫的披风");
            foreach (var seat in new[] { a, b, c, d })
            {
                string raw = await Body(h, seat, "", "/activity?after=0&limit=100");
                Check.True(raw.Contains("PUBLIC_VISIBLE_BADGE"));
                Check.Equal(seat == b, raw.Contains("B_RECOGNIZES_ITS_MEANING"));
            }
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: Configure(model));
            // Check retained private sources without applying the pre-public empty-window assertion again.
            Check.True((await Body(h, b, "", "/journal?after=0&limit=100")).Contains(privateBoth));
            Check.True(!(await Body(h, d, paths)).Contains(privateBoth));
            Check.Equal(0, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task ExplicitRetellingColdSourceRetryAndNoImplicitDisclosure()
    {
        const string secret = "KNOWN_DETAIL_NEVER_AUTO_PUBLISHED", remainder = "UNSAID_SECOND_SECRET";
        var model = new Model((_, _) => throw new Exception("Sharing never calls a model"));
        var h = await Host.Start(configure: Configure(model));
        try
        {
            var owner = await Create(h); var a = await HarnessBoundaryTests.Guest(h, owner);
            var b = await HarnessBoundaryTests.Guest(h, owner); var peer = await HarnessBoundaryTests.Guest(h, owner);
            string id = owner.Snapshot.Id;
            await Record(h, a, Story("", Message([b.Snapshot.Party!.SelfActorId], secret + "\n" + remainder)));
            Auth(h, b.AccessToken); var before = (await h.Get(id))!;
            var part = Part(await Get(h, id, "/activity?after=0&limit=100"), secret + "\n" + remainder);
            var source = part.GetProperty("source").Clone(); Check.True(source.GetProperty("partId").GetString()!.Length > 0);
            string text = "北边树后有人，小心！";
            var request = new { requestId = Id(), source, text };
            foreach (var denied in new[] { owner, a, peer })
            {
                Auth(h, denied.AccessToken);
                Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(Url(id, "/adventure/story/share"), request)).StatusCode);
            }
            var first = await Share(h, b, request);
            Check.Equal(before.Version, first.GetProperty("snapshot").GetProperty("version").GetInt32());
            Check.Equal(text, first.GetProperty("sharedStory").GetProperty("text").GetString());
            Check.Equal("retelling", first.GetProperty("sharedStory").GetProperty("publication").GetString());
            var duplicates = await Task.WhenAll(Share(h, b, request), Share(h, b, request));
            Check.True(duplicates.All(duplicate => duplicate.GetProperty("replayed").GetBoolean()));
            await Share(h, b, new { requestId = Id(), source, text });
            await Share(h, b, new { requestId = Id(), source, text = "我只看清了半截弓臂。" });
            Auth(h, b.AccessToken);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(Url(id, "/adventure/story/share"), new { request.requestId, source, text = "同ID篡改" })).StatusCode);
            var shared = await Get(h, id, "/adventure/story/shared?after=0&limit=100");
            Check.Equal(2, shared.GetProperty("entries").GetArrayLength());
            var stillPrivate = Part(await Get(h, id, "/activity?after=0&limit=100"), secret + "\n" + remainder);
            Check.True(stillPrivate.GetProperty("canShare").GetBoolean() && !stillPrivate.GetProperty("shared").GetBoolean());
            string peerBody = await Body(h, peer, "", "/activity?after=0&limit=100");
            Check.True(peerBody.Contains(text) && !peerBody.Contains(secret) && !peerBody.Contains(remainder));
            // Old sources are read from existing event storage, not just the snapshot tail.
            await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, campaign =>
            {
                for (int i = 0; i < 105; i++) campaign.Events.Add(new(Id(), ++campaign.Version, "fixture", "public", "", "fixture", DateTimeOffset.UtcNow, null));
                return Task.FromResult(0);
            });
            await Share(h, b, new { requestId = Id(), source, text = new string('文', 900) }); // exceeds the old 2048-byte HTTP limit
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: Configure(model));
            Check.True((await Share(h, b, request)).GetProperty("replayed").GetBoolean());
            Check.Equal(0, model.Calls);
            Check.True(!(await Body(h, peer, "")).Contains(remainder));
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task RealPiPrivateCompletionAndCurrentKnownInformation()
    {
        const string own = "B_KNOWN_EARLIER_LETTER", other = "C_PRIVATE_UNSEEN_LETTER";
        string actorB = "", actorC = "";
        var model = new Model((call, request) =>
        {
            if (call == 1) return Tool("world_record", Story("", Message([actorB], own + "：先前信件里写着北坡的口信。"), Message([actorC], other)));
            Check.Equal(2, call);
            var frame = HarnessExecutionProtocolTests.Frame(request);
            var known = frame.GetProperty("knownInformation");
            Check.Equal(actorB, known.GetProperty("actorId").GetString());
            // v45+ supplies source-addressed history once in the initial envelope,
            // removing those exact sources from the provider's knownInformation.
            using var envelope = JsonDocument.Parse(request.Messages.First().Content);
            string delivered = known.GetRawText() + envelope.RootElement.GetProperty("memory").GetRawText();
            Check.True(delivered.Contains(own) && !delivered.Contains(other));
            Check.True(!delivered.Contains("PRIVATE_ACTION_INPUT"), "Known state cannot be another private action transcript");
            return Tool("world_record", Story("", Message([actorB], "你辨认出信封内侧新露出的北坡印记。")));
        });
        var configure = Configure(model, extra: builder =>
        { builder.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); builder.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var h = await Host.Start(configure: configure);
        try
        {
            var owner = await Create(h); var a = await HarnessBoundaryTests.Guest(h, owner);
            var b = await HarnessBoundaryTests.Guest(h, owner); var c = await HarnessBoundaryTests.Guest(h, owner);
            string id = owner.Snapshot.Id; actorB = b.Snapshot.Party!.SelfActorId; actorC = c.Snapshot.Party!.SelfActorId;
            Auth(h, a.AccessToken); var initial = (await h.Get(id))!;
            var firstRequest = new HarnessInputRequest(Id(), initial.Version, "PRIVATE_ACTION_INPUT");
            var first = await Post<HarnessRunView>(h, id, "harness/runs", firstRequest);
            first = await Settled(h, id, first.Id, 3000);
            Check.True(first.Status == "completed", first.Status + "/" + first.Error); Check.Equal("", first.Text);
            var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, a.Snapshot.Party!.SelfActorId, first.Id)!;
            string frozen = HarnessJson.Serialize(saved.Steps.Single(s => s.Kind == "model").ExecutionFrame);
            Check.True(!frozen.Contains(own) && !frozen.Contains(other));
            // A relevant older known item survives both the private recent window and snapshot event tail.
            for (int i = 0; i < 16; i++) await Record(h, a, Story("", Message([actorB], "你听到窗外的风声，片段 " + i)));
            await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, campaign =>
            {
                for (int i = 0; i < 101; i++) campaign.Events.Add(new(Id(), ++campaign.Version, "fixture", "public", "", "fixture", DateTimeOffset.UtcNow, null));
                return Task.FromResult(0);
            });
            Auth(h, b.AccessToken); var second = await Start(h, (await h.Get(id))!, "回想先前信件中的口信");
            second = await Settled(h, id, second.Id, 3000); Check.True(second.Status == "completed", second.Status + "/" + second.Error);
            var secondSaved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, actorB, second.Id)!;
            var knownSnapshot = secondSaved.Steps.Single(s => s.Kind == "model").ExecutionFrame!.KnownInformation!;
            Check.True(knownSnapshot.Entries.Any(e => e.Text.Contains(own)) && !HarnessJson.Serialize(knownSnapshot).Contains(other));
            var game = h.App.Services.GetRequiredService<GameService>(); var auth = await game.AuthorizeHarness(id, b.AccessToken, default);
            var hostAuth = await game.AuthorizeHarness(id, owner.AccessToken, default);
            var hostFrame = HarnessJson.Element(await game.ReadHarnessExecution(id, owner.AccessToken, hostAuth.ActorId, Id(), "信件", hostAuth.Version, default, 43));
            Check.True(!hostFrame.GetProperty("knownInformation").GetRawText().Contains(own) && !hostFrame.GetProperty("knownInformation").GetRawText().Contains(other), "Host model must not inherit moderator read privileges");
            var old = await game.ReadHarnessExecution(id, b.AccessToken, actorB, Id(), "legacy", auth.Version, default, 42);
            Check.True(!HarnessJson.Serialize(old).Contains("knownInformation"));
            var peer = await game.ReadHarnessExecution(id, c.AccessToken, actorC, Id(), "信件", auth.Version, default, 43);
            string current = HarnessJson.Serialize(peer); Check.True(current.Contains(other) && !current.Contains(own));
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: configure);
            Auth(h, a.AccessToken); Check.True((await Post<HarnessRunView>(h, id, "harness/runs", firstRequest)).Replayed);
            var restored = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, a.Snapshot.Party!.SelfActorId, first.Id)!;
            Check.Equal(frozen, HarnessJson.Serialize(restored.Steps.Single(s => s.Kind == "model").ExecutionFrame));
            Check.Equal(2, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task EmptyOpeningAndNonActorSupplementRemainIndependent()
    {
        string actorB = "";
        var model = new Model((call, _) => Tool("opening_commit", new
        {
            @public = "", privateMessages = call == 1 ? new[] { Message([actorB], "B_ESTABLISHED_OPENING_MESSAGE") } : Array.Empty<object>()
        }));
        var configure = Configure(model, extra: builder =>
        { builder.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); builder.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var h = await Host.Start(configure: configure);
        try
        {
            var document = TestContent.Document with { Opening = new("harbor", ["harbor"]) };
            var owner = await Create(h, document); var b = await HarnessBoundaryTests.Guest(h, owner);
            var peer = await HarnessBoundaryTests.Guest(h, owner); actorB = b.Snapshot.Party!.SelfActorId; string id = owner.Snapshot.Id;
            Auth(h, owner.AccessToken); var initial = (await h.Get(id))!;
            var request = new StartOpeningRequest(Id(), initial.Version);
            var opening = await Post<AdventureSessionView>(h, id, "adventure/opening", request);
            var completed = await Settled(h, id, opening.SessionId, 3000);
            Check.True(completed.Status == "completed", completed.Status + "/" + completed.Error);
            var host = (await h.Get(id))!; Check.True(!host.Opening!.Needed && host.Opening.PublicSequence > 0 && host.Opening.PublicText == "");
            Auth(h, b.AccessToken); var beforeB = (await h.Get(id))!;
            Check.True(beforeB.Opening!.Needed, "Receiving another entry's supplement must not finish own entry");
            Check.True(HarnessJson.Serialize(beforeB.Opening).Contains("B_ESTABLISHED_OPENING_MESSAGE"));
            Auth(h, peer.AccessToken);
            string peerJson = (await Get(h, id)).GetRawText();
            Check.True(!peerJson.Contains("B_ESTABLISHED_OPENING_MESSAGE") && !peerJson.Contains("个人入场补充已保存"));
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: configure);
            Auth(h, owner.AccessToken); Check.True((await Post<AdventureSessionView>(h, id, "adventure/opening", request)).Replayed);
            Auth(h, b.AccessToken);
            var bOpening = await Post<AdventureSessionView>(h, id, "adventure/opening", new StartOpeningRequest(Id(), (await h.Get(id))!.Version));
            Check.Equal("completed", (await Settled(h, id, bOpening.SessionId, 3000)).Status);
            var after = (await h.Get(id))!; Check.True(!after.Opening!.Needed && after.Opening.PublicText == "");
            Check.Equal(host.Opening.PublicSequence, after.Opening.PublicSequence);
            Check.Equal(1, after.Opening.PrivateParts.Length);
            Check.True(!HarnessJson.Serialize(after.Events).Contains("个人入场补充已保存"));
            Check.Equal(2, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task PrivateRootNeverBecomesPublicWhenTheSameRunContinues()
    {
        const string input = "ORIGINAL_PRIVATE_INPUT_MUST_NOT_ESCAPE", firstText = "BC_FIRST_PRIVATE_MESSAGE", lastText = "B_LAST_PRIVATE_MESSAGE", publicText = "PUBLIC_BELL_AFTER_PRIVATE";
        string actorB = "", actorC = "";
        var atContinuation = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var model = new Model(async (call, _, ct) =>
        {
            if (call == 1) return Tool("world_record", new { narrative = "", memory = Array.Empty<object>(), privateMessages = new[] { Message([actorB, actorC], firstText) }, complete = false });
            if (call == 2)
            {
                atContinuation.TrySetResult(); await release.Task.WaitAsync(ct);
                return Tool("world_record", new { narrative = publicText, memory = Array.Empty<object>(), privateMessages = Array.Empty<object>(), complete = false });
            }
            Check.Equal(3, call); return Tool("world_record", Story("", Message([actorB], lastText)));
        });
        var configure = Configure(model, extra: builder =>
        { builder.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); builder.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var h = await Host.Start(configure: configure);
        try
        {
            var response = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new { name = "Private root continuation", adventure = TestContent.Document, preset = Preset });
            Check.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
            var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            var a = await HarnessBoundaryTests.Guest(h, owner); var b = await HarnessBoundaryTests.Guest(h, owner);
            var c = await HarnessBoundaryTests.Guest(h, owner); var d = await HarnessBoundaryTests.Guest(h, owner);
            string id = owner.Snapshot.Id; actorB = b.Snapshot.Party!.SelfActorId; actorC = c.Snapshot.Party!.SelfActorId;
            Auth(h, a.AccessToken); var request = new HarnessInputRequest(Id(), (await h.Get(id))!.Version, input);
            var run = await Post<HarnessRunView>(h, id, "harness/runs", request);
            await atContinuation.Task.WaitAsync(TimeSpan.FromSeconds(30));
            // Delivery is already readable while the same run is awaiting its next model reply.
            Check.True((await Body(h, b, "", "/activity?after=0&limit=100")).Contains(firstText));
            Check.True(!(await Body(h, d, "", "/activity?after=0&limit=100")).Contains(firstText));
            var (root, intentId) = await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false,
                campaign => { var intent = campaign.PendingIntents.Single(i => i.Text == input); return Task.FromResult((intent.RootSequence, intent.Id)); });
            release.TrySetResult(); Auth(h, a.AccessToken);
            run = await Settled(h, id, run.Id, 3000); Check.Equal("completed", run.Status);
            // A later authoritative public board step must retain its own changes, not reopen the input.
            var map = SharedBoardTests.Install(h, id, png: SharedBoardTests.MapPng(768, 512)) with { CurrentScene = true };
            var game = h.App.Services.GetRequiredService<GameService>();
            var auth = await game.AuthorizeHarness(id, a.AccessToken, default);
            await game.HarnessTool(id, a.AccessToken, auth.ActorId, intentId, input, auth.Version, Id(), Id(),
                new("token_spawn", HarnessJson.Element(new HarnessSpawnArgs(map.Id,
                    [new BoardSpawn("", "creature", new("player", auth.ActorId), new("公开出现的角色"), 0.25, 0.25, auth.ActorId)])), "placement"),
                [], default, auth.Profile, 43, contextAlreadyRead: true,
                suppliedBoardMap: new(map.Id, map.Title, map.Version, map.ContentHash, map.ImageUrl, map.Width, map.Height, map.Grid));
            async Task Verify()
            {
                foreach (var seat in new[] { b, c, d })
                {
                    string body = await Body(h, seat, "", "/events?after=0&limit=100", "/journal?after=0&limit=100", "/activity?after=0&limit=100");
                    Check.True(!body.Contains(input), "Later public result leaked the original private input");
                    Check.True(body.Contains(publicText), "Later public result disappeared with the private root");
                    Check.Equal(seat != d, body.Contains(firstText)); Check.Equal(seat == b, body.Contains(lastText));
                    Auth(h, seat.AccessToken);
                    var detail = await h.Http.GetAsync(Url(id, "/activity/" + root));
                    Check.Equal(seat == d ? HttpStatusCode.NotFound : HttpStatusCode.OK, detail.StatusCode);
                    Check.True(!(await detail.Content.ReadAsStringAsync()).Contains(input));
                    var activity = await Get(h, id, "/activity?after=0&limit=100");
                    var entries = activity.GetProperty("entries").EnumerateArray().ToArray();
                    var bell = entries.Single(e => e.GetProperty("narrative").GetString() == publicText);
                    Check.Equal(root, bell.GetProperty("continuationOf").GetInt32());
                    var placement = entries.Single(e => e.GetProperty("kind").GetString() == "board.spawn");
                    Check.Equal(root, placement.GetProperty("continuationOf").GetInt32());
                    Check.Equal(1, placement.GetProperty("steps").GetArrayLength());
                    foreach (var entry in new[] { bell, placement })
                        if (entry.TryGetProperty("origin", out var origin) && origin.ValueKind == JsonValueKind.Object)
                        { Check.Equal("", origin.GetProperty("input").GetString()); Check.Equal("", origin.GetProperty("label").GetString()); }
                    var publicDetail = await Get(h, id, "/activity/" + placement.GetProperty("sequence").GetInt32());
                    Check.True(!publicDetail.GetRawText().Contains(input));
                    Check.True((await h.Http.GetStringAsync(Url(id, $"/maps/{map.Id}/board"))).Contains(auth.ActorId));
                }
            }
            await Verify();
            Auth(h, owner.AccessToken);
            string exported = await h.Http.GetStringAsync(Url(id, "/journal/export"));
            Check.True(exported.Contains(firstText) && exported.Contains(lastText) && exported.Contains(publicText) && !exported.Contains(input));
            await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, campaign =>
            {
                for (int i = 0; i < 105; i++) campaign.Events.Add(new(Id(), ++campaign.Version, "fixture", "public", "", "fixture", DateTimeOffset.UtcNow, null));
                return Task.FromResult(0);
            });
            string path = h.Root; await h.DisposeAsync(); h = await Host.Start(path, configure: configure);
            await Verify(); Auth(h, a.AccessToken);
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", request)).Replayed); Check.Equal(3, model.Calls);
        }
        finally { release.TrySetResult(); await h.DisposeAsync(); }
    }

    public static async Task DiscoveryDeliveryIsExactAndRetellingDoesNotRevealMap()
    {
        var model = new Model((_, _) => throw new Exception("Exact delivery boundary uses no provider"));
        var dice = new SequenceDice(15, 15);
        var h = await Host.Start(dice: dice, configure: Configure(model));
        try
        {
            var owner = await Create(h); var b = await HarnessBoundaryTests.Guest(h, owner);
            var c = await HarnessBoundaryTests.Guest(h, owner); var peer = await HarnessBoundaryTests.Guest(h, owner);
            string id = owner.Snapshot.Id, actorB = b.Snapshot.Party!.SelfActorId, actorC = c.Snapshot.Party!.SelfActorId;
            var map = SharedBoardTests.Install(h, id, png: SharedBoardTests.MapPng(768, 512)) with { CurrentScene = true };
            var game = h.App.Services.GetRequiredService<GameService>(); var store = h.App.Services.GetRequiredService<CampaignStore>();
            var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
            await game.HarnessTool(id, owner.AccessToken, auth.ActorId, Id(), "隔离布置", auth.Version, Id(), Id(),
                new("token_spawn", HarnessJson.Element(new HarnessSpawnArgs(map.Id,
                new[] { owner, b, c, peer }.Select((seat, index) => new BoardSpawn("", "creature", new("player", seat.Snapshot.Party!.SelfActorId),
                    new("测试角色"), 1.5 / 12, (index + 1.5) / 8, seat.Snapshot.Party.SelfActorId)).ToArray())), "placement"),
                [], default, auth.Profile, 40, contextAlreadyRead: true,
                suppliedBoardMap: new(map.Id, map.Title, map.Version, map.ContentHash, map.ImageUrl, map.Width, map.Height, map.Grid));
            string first = "", second = "", encounter = "";
            await store.Access(id, owner.AccessToken, true, campaign =>
            {
                var placements = new[] {
                    new EncounterPlacement("xmm:goblin-warrior", "FIRST_HIDDEN_POSITION", "ranged", new(5.5 / 12, 2.5 / 8), "three-quarters-cover", "隔离掩护依据"),
                    new EncounterPlacement("xmm:goblin-warrior", "SECOND_HIDDEN_POSITION", "ranged", new(5.5 / 12, 4.5 / 8), "three-quarters-cover", "隔离掩护依据") };
                var setup = RuntimeEncounters.Prepare(campaign, map, new() { Type = "square", CellPixels = 64, Distance = 5, Units = "feet" },
                    "隔离发现", campaign.SceneId, "隔离测试来源", "测试DM战术标尺", placements,
                    Enumerable.Range(0, 8).Select(y => new BattleCell(3, y, "three-quarters-cover")).ToArray(), namingVersion: 40);
                setup = RuntimeEncounters.Establish(campaign, map, setup, placements, new RulesEngine(dice)); encounter = setup.Definition.Id;
                first = setup.Concealment![0].EntityId; second = setup.Concealment[1].EntityId;
                return Task.FromResult(0);
            });
            foreach (var seat in new[] { b, c, peer })
                await store.Access(id, seat.AccessToken, true, campaign =>
                { EncounterConcealment.Search(campaign, encounter, Id(), seat == peer ? 1 : 30, waitForNarrative: true); return Task.FromResult(0); });
            Check.Equal(2, dice.Count);
            async Task MapState(CreatedCampaign seat, bool firstVisible, bool secondVisible)
            {
                Auth(h, seat.AccessToken);
                string board = await h.Http.GetStringAsync(Url(id, $"/maps/{map.Id}/board"));
                Check.Equal(firstVisible, board.Contains("FIRST_HIDDEN_POSITION"));
                Check.Equal(secondVisible, board.Contains("SECOND_HIDDEN_POSITION"));
                Check.Equal(firstVisible ? HttpStatusCode.OK : HttpStatusCode.NotFound,
                    (await h.Http.GetAsync(Url(id, "/board/tokens/" + first))).StatusCode);
            }
            await MapState(b, false, false); await MapState(c, false, false); await MapState(peer, false, false);
            await Record(h, owner, Story("", Message([actorB, actorC], "你们注意到北坡树后的弓臂。", first)));
            await MapState(b, true, false); await MapState(c, true, false); await MapState(peer, false, false);
            // Unrelated private speech is not a release of all remaining discoveries.
            await Record(h, owner, Story("", Message([actorB], "你听见了同伴的低声提醒。")));
            await MapState(b, true, false);
            Auth(h, b.AccessToken); var source = Part(await Get(h, id, "/activity?after=0&limit=100"), "你们注意到北坡树后的弓臂。").GetProperty("source").Clone();
            await Share(h, b, new { requestId = Id(), source, text = "北边有动静，小心。" });
            await MapState(peer, false, false);
            Auth(h, owner.AccessToken); int version = (await h.Get(id))!.Version;
            try { await Record(h, owner, Story("", Message([peer.Snapshot.Party!.SelfActorId], "不应交付", second))); throw new Exception("Undiscovered target was delivered"); }
            catch (GameException) { }
            Check.Equal(version, (await h.Get(id))!.Version);
            Check.True(!(await Body(h, peer, "", "/activity?after=0&limit=100")).Contains("不应交付"));
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: Configure(model));
            await MapState(b, true, false); await MapState(peer, false, false);
            Check.Equal(2, dice.Count); Check.Equal(0, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }
}
