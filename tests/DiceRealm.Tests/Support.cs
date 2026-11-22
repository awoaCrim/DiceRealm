using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Api;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace DiceRealm.Tests;

internal static class Check
{
    public static void True(bool value, string message = "Assertion failed")
    { if (!value) throw new Exception(message); }
    public static void Equal<T>(T expected, T actual)
    { if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new Exception($"Expected {expected}, got {actual}"); }
    public static void Throws<T>(Action action) where T : Exception
    {
        try { action(); } catch (T) { return; }
        throw new Exception($"Expected {typeof(T).Name}");
    }
}
internal static class TestCharacterAssertions
{
    // Existing player fixtures require a real character; DM-only tests assert null.
    public static Character Required([System.Diagnostics.CodeAnalysis.NotNull] this Character? value) => value ?? throw new Exception("Expected an actual player character in this fixture");
}
internal sealed class SequenceDice(params int[] rolls) : IDice
{
    private int count;
    public int Count => count;
    public int Roll(int sides)
    {
        var i = Interlocked.Increment(ref count) - 1;
        return rolls.Length > i ? rolls[i] : 10;
    }
}
internal sealed class DisabledImages : IMapImageGenerator
{
    public bool Enabled => false;
    public string CacheIdentity => "disabled-test";
    public Task<byte[]> Generate(MapGenerationJob asset, CancellationToken cancellationToken) => throw new Exception("Must not generate");
}
// The live adapters hold no prompt fallback, so this fake fails the same way: it is only ever
// reached for campaigns that were created with an imported bundle.
internal sealed class BrokenText : IIntentInterpreter, INarrator
{
    public Task<Intent?> Interpret(string text, ActionChoice[] allowed, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null) => throw new HttpRequestException("offline");
    public Task<Narrative> Narrate(NarrativeContext context, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null) => throw new HttpRequestException("offline");
}
internal sealed class Host : IAsyncDisposable
{
    public WebApplication App { get; }
    public HttpClient Http { get; }
    public string Root { get; }
    private Host(WebApplication app, HttpClient http, string root) { App = app; Http = http; Root = root; }
    public static async Task<Host> Start(string? root = null, IDice? dice = null, BrokenText? broken = null, IMapImageGenerator? images = null, IIntentInterpreter? interpreter = null, INarrator? narrator = null, Action<WebApplicationBuilder>? configure = null)
    {
        root ??= Path.Combine(Path.GetTempPath(), "dicerealm-tests-" + Guid.NewGuid());
        var app = DiceRealmHost.Build([], builder =>
        {
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            builder.Configuration["DataPath"] = root;
            builder.Logging.ClearProviders();
            builder.Services.AddSingleton<IMapImageGenerator>(images ?? new DisabledImages());
            builder.Services.AddSingleton<IIntentInterpreter>(interpreter ?? (broken is null ? new OfflineText() : broken));
            builder.Services.AddSingleton<INarrator>(narrator ?? (broken is null ? new OfflineText() : broken));
            if (dice is not null) builder.Services.AddSingleton(dice);
            configure?.Invoke(builder);
        });
        await app.StartAsync();
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        return new(app, new HttpClient { BaseAddress = new Uri(address), Timeout = TimeSpan.FromSeconds(30) }, root);
    }
    // Creates a campaign from the external regression fixture: the imported adventure document and
    // prompt bundle travel with the request, and the scenario starts immediately at the authored
    // arrival scene. No server-side production adventure or prompt text exists to fall back to.
    public async Task<CreatedCampaign> Create(string name = "Test")
    {
        var response = await Http.PostAsJsonAsync("/api/v1/campaigns",
            new CreateCampaignRequest(name, "Arden", CharacterEngine.Fighter, TestContent.Document, TestContent.Prompts, StartImmediately: true, Build: FullCreationTests.Named("Arden")));
        Check.Equal(HttpStatusCode.Created, response.StatusCode);
        var result = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", result.AccessToken);
        return result;
    }
    // Explicit old-save fixture for preset-specific mechanics (e.g. retired level-two growth).
    // Never masquerades as successful new-character HTTP creation; behavior is read via HTTP.
    public async Task<CreatedCampaign> LoadLegacyCampaign(string name = "Legacy test", string characterName = "Arden", string template = CharacterEngine.Fighter)
    {
        string token = Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
        var campaign = TestContent.Campaign(name: name, tokenHash: token, character: CharacterEngine.Create(characterName, template));
        campaign.Events.Add(new(Guid.NewGuid().ToString(), 1, "arrival", Adventure.Current(campaign).Arrival, "", "authored", DateTimeOffset.UtcNow, null));
        App.Services.GetRequiredService<CampaignStore>().Create(campaign);
        Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
        return new(token, (await Get(campaign.Id))!);
    }
    public async Task<ActionResponse> Act(CampaignSnapshot snapshot, string kind, string target = "", string text = "")
    {
        var request = new ActionRequest(Guid.NewGuid().ToString(), snapshot.Version, kind, target, text);
        var response = await Send(snapshot.Id, request);
        if (response.StatusCode != HttpStatusCode.OK)
            throw new Exception($"{kind}: expected OK, got {response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        return (await response.Content.ReadFromJsonAsync<ActionResponse>())!;
    }
    public async Task<CreatedCampaign> ApproveGuest(CreatedCampaign owner, CreatedCampaign guest)
    {
        var previous = Http.DefaultRequestHeaders.Authorization;
        Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var s = (await Get(owner.Snapshot.Id))!;
        string actor = guest.Snapshot.Party!.SelfActorId;
        var review = s.Party!.Members.Single(m => m.Id == actor).Review!;
        var result = await Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/characters/review",
            new ReviewCharacterRequest(Guid.NewGuid().ToString(), s.Version, actor, review.Revision, "approve", "回归场景已审核"));
        Check.Equal(HttpStatusCode.OK, result.StatusCode);
        Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var updated = guest with { Snapshot = (await Get(s.Id))! };
        Http.DefaultRequestHeaders.Authorization = previous;
        return updated;
    }
    public Task<HttpResponseMessage> Send(string id, ActionRequest request) =>
        Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/actions", request);
    public async Task<ActionResponse> Rest(CampaignSnapshot s, string kind)
    {
        var response = await Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/party/rest", new PartyRestRequest(Guid.NewGuid().ToString(), s.Version, kind));
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<ActionResponse>())!;
    }
    public Task<CampaignSnapshot?> Get(string id) => Http.GetFromJsonAsync<CampaignSnapshot>($"/api/v1/campaigns/{id}");
    public async ValueTask DisposeAsync()
    {
        Http.Dispose(); await App.StopAsync(); await App.DisposeAsync();
    }
}
internal sealed class FakeHandler(string content) : HttpMessageHandler
{
    public int Calls { get; private set; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Calls++;
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        { Content = new StringContent(content) });
    }
    public static string Chat(object value) => JsonSerializer.Serialize(new
    {
        choices = new[] { new { message = new { content = JsonSerializer.Serialize(value) } } }
    });
}
