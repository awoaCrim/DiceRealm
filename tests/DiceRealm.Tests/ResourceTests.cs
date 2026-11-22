using System.Text.Json;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class ResourceTests
{
    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = new(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => Now;
    }
    public static void UnlimitedUsageRemainsDurable()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        { ["DataPath"] = Path.Combine(Path.GetTempPath(), "dicerealm-unlimited-" + Guid.NewGuid()) }).Build();
        using var directory = new DataDirectory(config);
        var budget = new ProviderBudget(directory, config);
        string campaign = Guid.NewGuid().ToString();
        for (int i = 0; i < 205; i++) budget.Reserve("text", campaign);
        var usage = new ProviderBudget(directory, config).Read("text", campaign, true);
        Check.True(usage.Unlimited); Check.Equal(-1, usage.RemainingToday); Check.Equal(205, usage.Total);
        budget.Reserve("image", campaign); Check.True(budget.Read("image", campaign, true).Unlimited);
    }
    public static async Task DurableQuotas()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DataPath"] = Path.Combine(Path.GetTempPath(), "dicerealm-quota-" + Guid.NewGuid()),
            ["ProviderLimits:TextDaily"] = "3", ["ProviderLimits:TextCampaignDaily"] = "2", ["ProviderLimits:TextTotal"] = "4"
        }).Build();
        using var directory = new DataDirectory(config); var clock = new Clock(); var budget = new ProviderBudget(directory, config, clock);
        string a = Guid.NewGuid().ToString(), b = Guid.NewGuid().ToString();
        var attempts = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => Task.Run(() =>
        { try { budget.Reserve("text", a); return true; } catch (ProviderQuotaException) { return false; } })));
        Check.Equal(2, attempts.Count(x => x)); Check.Equal(2, budget.Read("text", a, true).Total);
        budget = new ProviderBudget(directory, config, clock); // Reconstructing the module cannot reset usage.
        Check.Throws<ProviderQuotaException>(() => budget.Reserve("text", a)); budget.Reserve("text", b);
        Check.Throws<ProviderQuotaException>(() => budget.Reserve("text", b)); Check.Equal(3, budget.Read("text", b, true).Total);
        clock.Now = clock.Now.AddDays(1); Check.Equal(0, budget.Read("text", a, true).GlobalToday);
        budget.Reserve("text", b); Check.Throws<ProviderQuotaException>(() => budget.Reserve("text", a));
        Check.Equal(4, budget.Read("text", a, true).Total); Check.Equal(0, budget.Read("image", a, false).Total);
        config["ProviderLimits:ImageDaily"] = "-2"; Check.Throws<InvalidOperationException>(() => new ProviderBudget(directory, config));
    }
    public static async Task TextProviderAndAuthority()
    {
        var fake = new FakeHandler(FakeHandler.Chat(new { kind = "observe", target = "" }));
        await using var h = await Host.Start(configure: builder =>
        {
            builder.Configuration["ProviderLimits:TextCampaignDaily"] = "1";
            builder.Configuration["TextAi:ApiKey"] = "fake"; builder.Configuration["TextAi:Model"] = "fake";
            builder.Services.AddSingleton(services => new OpenAiText(new HttpClient(fake), builder.Configuration, services.GetRequiredService<ProviderBudget>()));
            builder.Services.AddSingleton<IIntentInterpreter>(s => s.GetRequiredService<OpenAiText>());
            builder.Services.AddSingleton<INarrator>(s => s.GetRequiredService<OpenAiText>());
        });
        var s = (await h.Create()).Snapshot;
        var request = new ActionRequest(Guid.NewGuid().ToString(), s.Version, "natural", "", "观察");
        var response = (await (await h.Send(s.Id, request)).Content.ReadFromJsonAsync<ActionResponse>())!; s = response.Snapshot;
        Check.Equal("observe", response.Resolution.Kind); Check.Equal("quota", s.Events[^1].NarrativeSource); Check.Equal(1, fake.Calls);
        Check.Equal(12, s.Character.Required().HitPoints);
        Check.True((await (await h.Send(s.Id, request)).Content.ReadFromJsonAsync<ActionResponse>())!.Replayed); Check.Equal(1, fake.Calls);
        s = (await h.Act(s, "talk")).Snapshot; Check.True(s.Facts.Contains("safe-route")); Check.Equal(1, fake.Calls);
        var resource = (await h.Http.GetFromJsonAsync<ResourceStatus>($"/api/v1/campaigns/{s.Id}/resources"))!;
        Check.Equal(1, resource.Usage.Single(x => x.Kind == "text").CampaignToday); Check.Equal(0, resource.Usage.Single(x => x.Kind == "image").Total);
        // A failed HTTP attempt is not refunded, while invalid configuration never reaches HTTP.
        var budget = h.App.Services.GetRequiredService<ProviderBudget>();
        var fail = new RecordingHandler { Status = HttpStatusCode.ServiceUnavailable };
        var other = Guid.NewGuid().ToString();
        var ai = new OpenAiText(new HttpClient(fail), h.App.Configuration, budget);
        try { await ai.Narrate(new("scene", "name", "outcome", []), default, other, TestContent.Prompts); throw new Exception("Expected HTTP failure"); } catch (HttpRequestException) { }
        Check.Equal(1, fail.Calls); Check.Equal(1, budget.Read("text", other, true).CampaignToday);
        try { await ai.Narrate(new("scene", "name", "outcome", []), default, other, TestContent.Prompts); throw new Exception("Expected quota failure"); } catch (ProviderQuotaException) { }
        Check.Equal(1, fail.Calls);
    }
    public static async Task MapsPermissionsAndQuota()
    {
        var handler = new RecordingHandler();
        var h = await Host.Start(configure: builder =>
        {
            builder.Configuration["ProviderLimits:ImageDaily"] = "2"; builder.Configuration["ProviderLimits:ImageTotal"] = "2";
            builder.Configuration["ImageAi:ApiKey"] = "fake"; builder.Configuration["ImageAi:Model"] = "fake";
            builder.Services.AddSingleton<IMapImageGenerator>(s => new OpenAiImages(new HttpClient(handler), builder.Configuration,
                s.GetRequiredService<SceneReferences>(), s.GetRequiredService<ProviderBudget>()));
        });
        var owner = await h.Create(); var s = owner.Snapshot; string id = s.Id; string path = $"/api/v1/campaigns/{id}/maps";
        var before = (await h.Http.GetFromJsonAsync<ResourceStatus>($"/api/v1/campaigns/{id}/resources"))!;
        Check.Equal(0, before.MainScenes.Length); Check.True(!before.CanPreGenerate); Check.Equal(0, handler.Calls);
        Check.Equal(HttpStatusCode.Gone, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/resources/pregenerate", new PreGenerateScenesRequest(["harbor"], true))).StatusCode);
        async Task<MapAssetView> Add(string prompt, string edition = "player")
        {
            var draft = (await (await h.Http.PostAsJsonAsync(path, AssetTests.Create(AssetTests.Spec(prompt, edition: edition)))).Content.ReadFromJsonAsync<MapAssetView>())!;
            var request = AssetTests.Generate(draft);
            var replies = await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => h.Http.PostAsJsonAsync(path + "/" + draft.Id + "/generate", request)));
            foreach (var reply in replies) Check.Equal(HttpStatusCode.OK, reply.StatusCode);
            await AssetTests.Until(async () => (await h.Http.GetFromJsonAsync<MapAssetView>(path + "/" + draft.Id))!.Status is "ready" or "failed");
            return (await h.Http.GetFromJsonAsync<MapAssetView>(path + "/" + draft.Id))!;
        }
        var first = await Add("PRIVATE player cartography prompt"); var gm = await Add("PRIVATE GM map", "gm"); var quota = await Add("third distinct map");
        Check.Equal(2, handler.Calls); Check.Equal("image_quota_exceeded", quota.Error);
        Check.Equal(2, (await h.Http.GetFromJsonAsync<ResourceStatus>($"/api/v1/campaigns/{id}/resources"))!.Usage.Single(x => x.Kind == "image").Total);
        var cached = await Add("PRIVATE player cartography prompt"); Check.Equal("ready", cached.Status); Check.Equal(2, handler.Calls);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(path + "/" + gm.Id + "/publish", new PublishMapRequest(Guid.NewGuid().ToString(), gm.Version, true, true))).StatusCode);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(path + "/" + first.Id + "/publish", new PublishMapRequest(Guid.NewGuid().ToString(), first.Version, true, false))).StatusCode);
        var published = (await (await h.Http.PostAsJsonAsync(path + "/" + first.Id + "/publish", new PublishMapRequest(Guid.NewGuid().ToString(), first.Version, true, true))).Content.ReadFromJsonAsync<MapAssetView>())!;
        s = (await h.Get(id))!; Check.Equal(1, s.Version); Check.Equal(1, s.VisitedScenes.Length); Check.Equal(0, s.Facts.Length); Check.Equal(1, s.Events.Length);
        var invite = new InviteRequest(Guid.NewGuid().ToString(), s.Version, new string('c', 64));
        await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/invitations", invite);
        var guest = (await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/join", new JoinCampaignRequest(Guid.NewGuid().ToString(), invite.InviteToken, new string('d', 64), "Guest", Build: FullCreationTests.Named("Guest")))).Content.ReadFromJsonAsync<CreatedCampaign>())!;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.GetAsync($"/api/v1/campaigns/{id}/references")).StatusCode);
        var publicJson = await h.Http.GetStringAsync(path); Check.True(!publicJson.Contains("PRIVATE") && !publicJson.Contains("specification"));
        var listed = JsonSerializer.Deserialize<MapLibraryView>(publicJson, JsonFiles.Options)!; Check.Equal(1, listed.Maps.Length); Check.True(!listed.CanManage);
        Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync(path + "/" + gm.Id)).StatusCode);
        Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync(path + "/" + gm.Id + "/image")).StatusCode);
        Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync(path + "/" + cached.Id + "/image")).StatusCode);
        Check.True((await h.Http.GetByteArrayAsync(published.ImageUrl)).SequenceEqual(AssetTests.Png));
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync(path, AssetTests.Create())).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync(path + "/" + quota.Id + "/generate", AssetTests.Generate(quota))).StatusCode);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        await h.Http.PostAsJsonAsync(path + "/" + first.Id + "/grid", new ConfigureMapGridRequest(Guid.NewGuid().ToString(), published.Version, new() { Type = "hex", Distance = 1, Units = "miles" }));
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync(published.ImageUrl)).StatusCode);
        var root = h.Root; await h.DisposeAsync();
        await using var restart = await Host.Start(root); restart.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        Check.Equal(2, (await restart.Http.GetFromJsonAsync<ResourceStatus>($"/api/v1/campaigns/{id}/resources"))!.Usage.Single(x => x.Kind == "image").Total);
        Check.Equal("ready", (await restart.Http.GetFromJsonAsync<MapAssetView>(path + "/" + first.Id))!.Status);
    }
}
