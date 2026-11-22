using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Tests;

internal static class AuthoringTests
{
    private sealed class CountingText : IIntentInterpreter, INarrator
    {
        public int Calls;
        public Task<Intent?> Interpret(string text, ActionChoice[] allowed, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null)
        { Calls++; return Task.FromResult<Intent?>(new("observe", "")); }
        public Task<Narrative> Narrate(NarrativeContext context, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null)
        { Calls++; return Task.FromResult(new Narrative("test output", "test")); }
    }
    private sealed class CountingImages : IMapImageGenerator
    {
        public int Calls; public bool Enabled => true; public string CacheIdentity => "test";
        public Task<byte[]> Generate(MapGenerationJob asset, CancellationToken cancellationToken) { Calls++; throw new Exception("No trial provider calls allowed"); }
    }
    public static async Task VersionsAndTrace()
    {
        var text = new CountingText(); var host = await Host.Start(interpreter: text, narrator: text);
        var created = await host.Create(); var s = created.Snapshot; var original = s.Content!.Prompts!;
        var p = TestContent.Prompts with { Version = "new-version", Narration = "Author revised\r\nsource" };
        var import = new ImportPromptsRequest(Guid.NewGuid().ToString(), s.Version, p);
        var response = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/prompts", import);
        Check.Equal(HttpStatusCode.OK, response.StatusCode); s = (await response.Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot;
        var history = (await host.Http.GetFromJsonAsync<PromptRevision[]>($"/api/v1/campaigns/{s.Id}/content/prompt-history"))!;
        Check.Equal(2, history.Length); Check.Equal(p.Narration, history.Last().Document.Narration);
        Check.Equal(0, text.Calls);
        var bad = import with { RequestId = Guid.NewGuid().ToString(), ExpectedVersion = s.Version, Document = p with { Narration = "overwrite forbidden" } };
        Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/prompts", bad)).StatusCode);
        Check.Equal(s.Version, (await host.Get(s.Id))!.Version);
        s = (await host.Act(s, "natural", text: "test input")).Snapshot;
        Check.Equal(2, text.Calls); var calls = s.Events.Last().PromptCalls!;
        Check.Equal(2, calls.Length); Check.Equal("intent", calls[0].Purpose); Check.Equal("narration", calls[1].Purpose);
        Check.True(calls.All(c => c.Binding.Hash == s.Content!.Prompts!.Hash));
        Check.True(!JsonSerializer.Serialize(s).Contains(p.Narration));
        var bind = new BindPromptsRequest(Guid.NewGuid().ToString(), s.Version, original.Hash);
        response = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/prompts-bind", bind);
        Check.Equal(HttpStatusCode.OK, response.StatusCode); s = (await response.Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot;
        Check.Equal(original.Hash, s.Content!.Prompts!.Hash);
        var root = host.Root; await host.DisposeAsync();
        await using var restart = await Host.Start(root, interpreter: text, narrator: text);
        restart.Http.DefaultRequestHeaders.Authorization = new("Bearer", created.AccessToken);
        response = await restart.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/prompts-bind", bind);
        Check.True((await response.Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
        history = (await restart.Http.GetFromJsonAsync<PromptRevision[]>($"/api/v1/campaigns/{s.Id}/content/prompt-history"))!; Check.Equal(2, history.Length);
        s = (await restart.Act(s, "observe")).Snapshot;
        Check.Equal(original.Hash, s.Events.Last().PromptCalls!.Single().Binding.Hash);
    }
    public static async Task PreflightAndOfflineTrial()
    {
        var text = new CountingText(); var images = new CountingImages(); var host = await Host.Start(interpreter: text, narrator: text, images: images);
        var source = await host.Create(); var s = source.Snapshot;
        var sourceFile = Path.Combine(host.Root, "campaigns", s.Id + ".sqlite"); var before = File.ReadAllBytes(sourceFile);
        var document = TestContent.Document with { Scenes = [.. TestContent.Document.Scenes, new() { Id = "unreachable-test", Title = "User isolated node", Actions = [new() { Id = "repeat-test", Label = "User repeated reward", Repeatable = true, Success = new("", [new("item", "gold-piece", 1)]) }] }] };
        var report = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/preflight", new PreflightRequest(document, TestContent.Prompts));
        Check.Equal(HttpStatusCode.OK, report.StatusCode); var checkedContent = (await report.Content.ReadFromJsonAsync<ContentPreflight>())!;
        Check.True(checkedContent.Valid); Check.Equal(2, checkedContent.Issues.Count(i => i.Severity == "warning"));
        report = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/preflight", new PreflightRequest(document with { StartSceneId = "missing" }));
        Check.True(!(await report.Content.ReadFromJsonAsync<ContentPreflight>())!.Valid);
        var request = new TrialRequest(Guid.NewGuid().ToString(), s.Version, new string('d', 64), document, TestContent.Prompts);
        var replies = await Task.WhenAll(Enumerable.Range(0, 2).Select(_ => host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/trial", request)));
        foreach (var reply in replies) Check.Equal(HttpStatusCode.OK, reply.StatusCode);
        var trial = (await replies[0].Content.ReadFromJsonAsync<TrialResponse>())!.Trial;
        Check.Equal(trial.Snapshot.Id, (await replies[1].Content.ReadFromJsonAsync<TrialResponse>())!.Trial.Snapshot.Id);
        Check.True(trial.Snapshot.Id != s.Id); Check.True(trial.Snapshot.Content!.OfflineTrial); Check.True(before.SequenceEqual(File.ReadAllBytes(sourceFile)));
        var conflict = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/trial", request with { Document = document with { Name = "Different" } });
        Check.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", trial.AccessToken);
        var maps = (await host.Http.GetFromJsonAsync<MapLibraryView>($"/api/v1/campaigns/{trial.Snapshot.Id}/maps"))!;
        Check.True(!maps.GenerationEnabled);
        var usage = (await host.Http.GetFromJsonAsync<ResourceStatus>($"/api/v1/campaigns/{trial.Snapshot.Id}/resources"))!;
        Check.True(usage.Usage.All(u => !u.Enabled && u.CampaignToday == 0));
        var action = new ActionRequest(Guid.NewGuid().ToString(), trial.Snapshot.Version, "investigate");
        var result = (await (await host.Send(trial.Snapshot.Id, action)).Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(result.Snapshot.Facts.Length > 0); Check.Equal("offline-trial", result.Snapshot.Events.Last().NarrativeSource);
        Check.Equal(0, result.Snapshot.Events.Last().PromptCalls!.Length);
        var pending = await host.Act(result.Snapshot, "natural", text: "trial unsupported input");
        Check.Equal("needs_adjudication", pending.Resolution.Status); Check.Equal(0, text.Calls);
        // Even a direct forged map request is refused before a job, quota, or provider is touched.
        var denied = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{trial.Snapshot.Id}/maps/forged/generate", new { requestId = Guid.NewGuid().ToString(), expectedVersion = 1, confirmProviderUse = true });
        Check.Equal(HttpStatusCode.Conflict, denied.StatusCode); Check.True((await denied.Content.ReadAsStringAsync()).Contains("trial_provider_disabled"));
        Check.Equal(0, images.Calls); Check.True(before.SequenceEqual(File.ReadAllBytes(sourceFile)));
        var root = host.Root; await host.DisposeAsync();
        await using var restart = await Host.Start(root, interpreter: text, narrator: text, images: images);
        restart.Http.DefaultRequestHeaders.Authorization = new("Bearer", source.AccessToken);
        trial = (await (await restart.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/trial", request)).Content.ReadFromJsonAsync<TrialResponse>())!.Trial;
        Check.Equal(pending.Snapshot.Version, trial.Snapshot.Version);
        restart.Http.DefaultRequestHeaders.Authorization = new("Bearer", trial.AccessToken);
        Check.True((await (await restart.Send(trial.Snapshot.Id, action)).Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
        await restart.Act(trial.Snapshot, "observe"); Check.Equal(0, text.Calls); Check.Equal(0, images.Calls);
        Check.True(before.SequenceEqual(File.ReadAllBytes(sourceFile)));
    }
}
