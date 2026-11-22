using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class CharacterPortraitTests
{
    private sealed class Images : IMapImageGenerator
    {
        public bool Enabled { get; set; } = true;
        public string CacheIdentity { get; set; } = "isolated-portraits-v1";
        public ConcurrentQueue<ImageGenerationRequest> Requests { get; } = new();
        public Func<ImageGenerationRequest, CancellationToken, Task<byte[]>>? Reply;
        public Task<byte[]> Generate(MapGenerationJob job, CancellationToken ct) => throw new Exception("Portrait must not be a map job");
        public Task<byte[]> Generate(ImageGenerationRequest image, CancellationToken ct)
        {
            Requests.Enqueue(image);
            return Reply?.Invoke(image, ct) ?? Task.FromResult(SharedBoardTests.MapPng(Appearance(image.Prompt).Contains("银色短发") ? 256 : 320, 256));
        }
    }
    private static string Appearance(string prompt) => JsonDocument.Parse(prompt[prompt.IndexOf('{')..]).RootElement.GetProperty("appearance").GetString()!;
    private static string Token() => Id().Replace("-", "") + Id().Replace("-", "");
    private static string Route(string actor) => $"characters/{actor}/portrait";
    private static CharacterBuild Build(string name, string appearance, bool wizard = false)
    {
        var build = FullCreationTests.Named(name, wizard ? CharacterEngine.Wizard : CharacterEngine.Fighter);
        return build with { Identity = build.Identity with { Appearance = appearance, Pronouns = "they/them", Backstory = "PRIVATE_BACKSTORY_DO_NOT_SEND", Personality = "PRIVATE_PERSONALITY_DO_NOT_SEND" } };
    }
    private static async Task<CharacterPortraitView> WaitPortrait(Host h, string campaign, string actor, string status)
    {
        for (int i = 0; i < 200; i++)
        {
            var portrait = (await h.Http.GetFromJsonAsync<CharacterPortraitView>($"/api/v1/campaigns/{campaign}/{Route(actor)}"))!;
            if (portrait.Status == status) return portrait;
            if (portrait.Status is "failed" or "unknown" && status == "ready") throw new Exception(portrait.Status + "/" + portrait.Error);
            await Task.Delay(25);
        }
        throw new Exception("Portrait did not reach " + status);
    }
    private static async Task<(CreatedCampaign Guest, JoinCampaignRequest Request)> InviteJoin(Host h, CreatedCampaign owner, CharacterBuild build)
    {
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var s = (await h.Get(owner.Snapshot.Id))!;
        string invite = Token();
        await Post<ActionResponse>(h, s.Id, "invitations", new InviteRequest(Id(), s.Version, invite));
        var request = new JoinCampaignRequest(Id(), invite, Token(), build.Identity.Name, Build: build);
        return (await Post<CreatedCampaign>(h, s.Id, "join", request), request);
    }

    public static async Task JoinImagesPrivacyReuseAndRestart()
    {
        var images = new Images(); var h = await Host.Start(images: images);
        try
        {
            var owner = await h.Create(); string id = owner.Snapshot.Id;
            // Reading an existing character never authorizes a supplier request.
            var existing = (await h.Http.GetFromJsonAsync<CharacterPortraitView>($"/api/v1/campaigns/{id}/{Route("player")}"))!;
            Check.Equal("missing", existing.Status); Check.Equal(0, images.Requests.Count);
            var build = Build("Silver", "银色短发，灰色眼睛，深色锁甲。");
            var (first, firstRequest) = await InviteJoin(h, owner, build);
            string firstActor = first.Snapshot.Party!.SelfActorId;
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", first.AccessToken);
            var firstPortrait = await WaitPortrait(h, id, firstActor, "ready");
            Check.Equal(1, images.Requests.Count);
            Check.Equal(firstPortrait.Id, first.Snapshot.Character!.Portrait!.Id);
            var replays = await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => Post<CreatedCampaign>(h, id, "join", firstRequest)));
            Check.True(replays.All(x => x.Snapshot.Character!.Portrait!.Id == firstPortrait.Id));
            // A second visual identity enters through the other production join path.
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            await Post<ActionResponse>(h, id, "room", new ConfigureRoomRequest(Id(), (await h.Get(id))!.Version, true, "isolated-portrait-password"));
            var room = (await h.Http.GetFromJsonAsync<RoomView>($"/api/v1/campaigns/{id}/room"))!;
            var secondBuild = Build("Copper", "铜色卷发，雀斑，蓝色法袍。", wizard: true);
            var joinRoom = new JoinRoomRequest(room.RoomNumber, "isolated-portrait-password", Id(), Token(), secondBuild);
            var joined = await h.Http.PostAsJsonAsync("/api/v1/rooms/join", joinRoom);
            Check.Equal(HttpStatusCode.OK, joined.StatusCode);
            var second = (await joined.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            string secondActor = second.Snapshot.Party!.SelfActorId;
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", second.AccessToken);
            var secondPortrait = await WaitPortrait(h, id, secondActor, "ready");
            Check.True(firstPortrait.Id != secondPortrait.Id && firstPortrait.ContentHash != secondPortrait.ContentHash);
            Check.Equal(2, images.Requests.Count);
            Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync(firstPortrait.ImageUrl)).StatusCode);
            Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync($"/api/v1/campaigns/{id}/{Route(firstActor)}")).StatusCode);
            first = await h.ApproveGuest(owner, first); second = await h.ApproveGuest(owner, second);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", second.AccessToken);
            var peerImage = await h.Http.GetAsync(firstPortrait.ImageUrl);
            Check.Equal(HttpStatusCode.OK, peerImage.StatusCode);
            Check.True((await peerImage.Content.ReadAsByteArrayAsync()).SequenceEqual(SharedBoardTests.MapPng(256, 256)));
            Check.True(peerImage.Headers.CacheControl!.NoStore);
            Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/{Route(firstActor)}", new RequestCharacterPortrait(Id(), firstPortrait.Id))).StatusCode);
            var snapshot = (await h.Get(id))!;
            Check.Equal(secondPortrait.ContentHash, snapshot.Character!.Portrait!.ContentHash);
            Check.Equal(firstPortrait.ContentHash, snapshot.Party!.Members.Single(m => m.Id == firstActor).Character.Portrait!.ContentHash);
            var sheet = await h.Http.GetStringAsync($"/api/v1/campaigns/{id}/character/sheet");
            Check.True(sheet.Contains(secondPortrait.ContentHash));
            var map = SharedBoardTests.Install(h, id);
            var spawned = await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands",
                new BoardCommandRequest(Id(), snapshot.Version, map.Id, "spawn", Spawns:
                    [new("", "creature", new("player", secondActor), new("ignored"), .3, .4, secondActor)], ExpectedMapVersion: map.Version));
            var boardToken = spawned.Board.Tokens.Single(t => t.ActorId == secondActor);
            Check.Equal(secondPortrait.ContentHash, boardToken.Portrait!.ContentHash);
            var boardDetail = (await h.Http.GetFromJsonAsync<BoardTokenDetail>($"/api/v1/campaigns/{id}/board/tokens/{boardToken.Id}"))!;
            Check.Equal(secondPortrait.ContentHash, boardDetail.Portrait!.ContentHash);
            Check.Equal(secondPortrait.ContentHash, boardDetail.Character!.Portrait!.ContentHash);
            // Initial build identity survives actual mutable game state changes.
            await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, c =>
            {
                var member = c.PartyMembers.Single(m => m.Id == firstActor);
                member.Character = member.Character with { HitPoints = member.Character.HitPoints - 1, Inventory = [] };
                c.Version++; c.Events.Add(new(Id(), c.Version, "fixture.damage", "isolated state-owner change", "", "test", DateTimeOffset.UtcNow, null));
                return Task.FromResult(true);
            }, default);
            var afterDamage = await WaitPortrait(h, id, firstActor, "ready"); Check.Equal(firstPortrait.Id, afterDamage.Id);
            Check.Equal(2, images.Requests.Count);
            foreach (var request in images.Requests)
            {
                Check.True(request.Prompt.Contains("Baldur's Gate 3") && request.Prompt.Contains("No text"));
                Check.True(!request.Prompt.Contains("PRIVATE_"));
                Check.Equal(1024, request.Width); Check.Equal(1024, request.Height);
            }
            Check.True(Appearance(images.Requests.First().Prompt).Contains("银色短发"));
            Check.True(Appearance(images.Requests.Last().Prompt).Contains("铜色卷发"));
            var other = await h.Create();
            Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.GetAsync(firstPortrait.ImageUrl)).StatusCode);
            var (reused, _) = await InviteJoin(h, other, build);
            Check.Equal(firstPortrait.Id, reused.Snapshot.Character!.Portrait!.Id);
            Check.Equal("ready", reused.Snapshot.Character.Portrait.Status); Check.Equal(2, images.Requests.Count);
            h.Http.DefaultRequestHeaders.Authorization = null;
            Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.GetAsync(firstPortrait.ImageUrl)).StatusCode);
            string root = h.Root; await h.DisposeAsync(); images.Enabled = false; images.CacheIdentity = "changed-provider";
            h = await Host.Start(root, images: images); h.Http.DefaultRequestHeaders.Authorization = new("Bearer", first.AccessToken);
            var restarted = await WaitPortrait(h, id, firstActor, "ready");
            Check.Equal(firstPortrait.ContentHash, restarted.ContentHash);
            Check.Equal(HttpStatusCode.OK, (await h.Http.GetAsync(restarted.ImageUrl)).StatusCode);
            Check.Equal(HttpStatusCode.OK, (await h.Http.PostAsJsonAsync("/api/v1/rooms/join", joinRoom)).StatusCode);
            Check.Equal(firstPortrait.Id, (await Post<CreatedCampaign>(h, id, "join", firstRequest)).Snapshot.Character!.Portrait!.Id);
            Check.Equal(2, images.Requests.Count);
            // No source prompts, local receipt data or credentials enter a public portrait DTO.
            string publicJson = JsonSerializer.Serialize(restarted, JsonFiles.Options);
            Check.True(!publicJson.Contains("PRIVATE_") && !publicJson.Contains("provider") && !publicJson.Contains("prompt") && !publicJson.Contains(first.AccessToken));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            await Post<ActionResponse>(h, id, "seats/revoke", new RevokeSeatRequest(Id(), (await h.Get(id))!.Version, firstActor));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", second.AccessToken);
            Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync(firstPortrait.ImageUrl)).StatusCode);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task InterruptedGenerationNeedsExplicitRetry()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var images = new Images { Reply = async (_, ct) => { started.TrySetResult(); await Task.Delay(Timeout.Infinite, ct); return []; } };
        var h = await Host.Start(images: images);
        try
        {
            var owner = await h.Create(); string id = owner.Snapshot.Id;
            var (guest, join) = await InviteJoin(h, owner, Build("Interrupted", "银色短发，深色斗篷。"));
            string actor = guest.Snapshot.Party!.SelfActorId;
            await started.Task.WaitAsync(TimeSpan.FromSeconds(10));
            string root = h.Root; await h.DisposeAsync();
            images.Reply = null; h = await Host.Start(root, images: images);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var unknown = await WaitPortrait(h, id, actor, "unknown");
            Check.Equal(1, images.Requests.Count); Check.True(unknown.FailureId.Length > 0);
            await Post<CreatedCampaign>(h, id, "join", join);
            Check.Equal("unknown", (await WaitPortrait(h, id, actor, "unknown")).Status); Check.Equal(1, images.Requests.Count);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/{Route(actor)}", new RequestCharacterPortrait(Id(), unknown.Id))).StatusCode);
            var retry = new RequestCharacterPortrait(Id(), unknown.Id, unknown.FailureId);
            await Post<CharacterPortraitResponse>(h, id, Route(actor), retry);
            var ready = await WaitPortrait(h, id, actor, "ready"); Check.Equal(2, images.Requests.Count);
            Check.True((await Post<CharacterPortraitResponse>(h, id, Route(actor), retry)).Replayed);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/{Route(actor)}", retry with { RetryFailureId = "different" })).StatusCode);
            Check.Equal(ready.Id, unknown.Id); Check.Equal(2, images.Requests.Count);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task DisabledRegistrationResubmitAndIoRecovery()
    {
        var images = new Images { Enabled = false }; await using var h = await Host.Start(images: images);
        var owner = await h.Create(); string id = owner.Snapshot.Id;
        var original = Build("Changed", "银色短发，灰眼睛。");
        var (guest, join) = await InviteJoin(h, owner, original); string actor = guest.Snapshot.Party!.SelfActorId;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var unavailable = await WaitPortrait(h, id, actor, "unavailable"); Check.Equal(0, images.Requests.Count);
        images.Enabled = true;
        await Post<CreatedCampaign>(h, id, "join", join);
        Check.Equal("unavailable", (await WaitPortrait(h, id, actor, "unavailable")).Status);
        Check.Equal(0, images.Requests.Count);
        await Post<CharacterPortraitResponse>(h, id, Route(actor), new RequestCharacterPortrait(Id(), unavailable.Id, unavailable.FailureId));
        var before = await WaitPortrait(h, id, actor, "ready"); Check.Equal(1, images.Requests.Count);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var current = (await h.Get(id))!;
        await Post<ActionResponse>(h, id, "characters/review", new ReviewCharacterRequest(Id(), current.Version, actor, 1, "return", "请补充外貌"));
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var changedBuild = original with { Identity = original.Identity with { Appearance = "铜色卷发，绿色眼睛。" } };
        var resubmit = new ResubmitCharacterRequest(Id(), (await h.Get(id))!.Version, 1, "已补充外貌。", original.Identity.Name, Build: changedBuild);
        var changed = await Post<ActionResponse>(h, id, "character/resubmit", resubmit);
        Check.Equal(guest.Snapshot.Character!.Id, changed.Snapshot.Character!.Id);
        var after = await WaitPortrait(h, id, actor, "ready"); Check.True(before.Id != after.Id); Check.Equal(2, images.Requests.Count);
        Check.True((await Post<ActionResponse>(h, id, "character/resubmit", resubmit)).Replayed);
        Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync(before.ImageUrl)).StatusCode);
        Check.Equal(2, images.Requests.Count);
        // Disk failure AFTER Join must not turn the committed seat into a failed admission.
        var ioBuild = Build("Recovery", "紫色长发，黑色皮甲。");
        var spec = CharacterPortraits.Describe(BuildEvaluator.Create(ioBuild));
        string obstacle = Path.Combine(h.Root, "portraits", spec.Id + ".json"); Directory.CreateDirectory(obstacle);
        var (ioGuest, ioJoin) = await InviteJoin(h, owner, ioBuild);
        Check.Equal("failed", ioGuest.Snapshot.Character!.Portrait!.Status);
        Check.Equal("portrait_registration_failed", ioGuest.Snapshot.Character.Portrait.Error);
        Directory.Delete(obstacle); // Remove only this test's empty storage obstruction.
        var recovered = await Post<CreatedCampaign>(h, id, "join", ioJoin);
        Check.Equal(ioGuest.Snapshot.Character.Id, recovered.Snapshot.Character!.Id);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", ioGuest.AccessToken);
        _ = await WaitPortrait(h, id, ioGuest.Snapshot.Party!.SelfActorId, "ready"); Check.Equal(3, images.Requests.Count);
    }

    private sealed class Wire : HttpMessageHandler
    {
        public JsonElement Body;
        public int Calls;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++; Check.Equal("Bearer", request.Headers.Authorization!.Scheme);
            Body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct)).RootElement.Clone();
            return new(HttpStatusCode.OK) { Content = JsonContent.Create(new { data = new[] { new { b64_json = Convert.ToBase64String(SharedBoardTests.MapPng(256, 256)) } } }) };
        }
    }
    public static async Task ExistingAdapterUsesOneImageRequest()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DataPath"] = Path.Combine(Path.GetTempPath(), "portrait-adapter-" + Id()),
            ["ImageAi:Endpoint"] = "http://127.0.0.1:1/images/generations", ["ImageAi:Model"] = "isolated-image-model", ["ImageAi:ApiKey"] = "fake-portrait-key"
        }).Build();
        using var directory = new DataDirectory(config); var budget = new ProviderBudget(directory, config);
        using var wire = new Wire(); using var http = new HttpClient(wire);
        var adapter = new OpenAiImages(http, config, new SceneReferences(directory), budget);
        var character = BuildEvaluator.Create(Build("Portrait", "银色短发，灰眼睛。"));
        var spec = CharacterPortraits.Describe(character);
        var bytes = await adapter.Generate(new ImageGenerationRequest(Id(), adapter.CacheIdentity, spec.Prompt, 1024, 1024), default);
        Check.Equal(1, wire.Calls); Check.Equal(256, PngGuard.Dimensions(bytes).width);
        Check.Equal(spec.Prompt, wire.Body.GetProperty("prompt").GetString());
        Check.Equal(1, wire.Body.GetProperty("n").GetInt32()); Check.Equal("1024x1024", wire.Body.GetProperty("size").GetString());
        Check.True(!wire.Body.TryGetProperty("image", out _) && !wire.Body.ToString().Contains("PRIVATE_"));
        var normalized = character with { Build = character.Build! with { Selections = character.Build.Selections.Reverse().ToArray(), Identity = character.Build.Identity with { Appearance = "  银色短发，灰眼睛。  " } } };
        Check.Equal(spec.Id, CharacterPortraits.Describe(normalized).Id);
        Check.True(spec.Id != CharacterPortraits.Describe(character with { Build = character.Build! with { Identity = character.Build.Identity with { Appearance = "黑色长发。" } } }).Id);
    }
}
