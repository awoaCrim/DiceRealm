using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class PreparationConcurrencyTests
{
    private static readonly TimeSpan WaitLimit = TimeSpan.FromSeconds(8);
    private static string Id() => Guid.NewGuid().ToString();
    private const string Source = "雾港的旧灯室等待调查。";

    private sealed class BlockingGenerator : IPreparationGenerator
    {
        private readonly TaskCompletionSource entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int calls;
        public int Calls => Volatile.Read(ref calls);
        public bool Enabled => true;
        public string Model => "controlled-fake";
        public Task Entered => entered.Task;
        public void Release() => release.TrySetResult();
        public async Task<PreparationProposal> Generate(PreparationGenerationRequest request, CancellationToken ct, string campaignId)
        {
            Interlocked.Increment(ref calls);
            entered.TrySetResult();
            await release.Task.WaitAsync(ct);
            return Proposal();
        }
    }

    private sealed class CountingGenerator : IPreparationGenerator
    {
        private int calls;
        public int Calls => Volatile.Read(ref calls);
        public bool Enabled => true;
        public string Model => "restart-fake";
        public Task<PreparationProposal> Generate(PreparationGenerationRequest request, CancellationToken ct, string campaignId)
        {
            Interlocked.Increment(ref calls);
            return Task.FromResult(Proposal());
        }
    }

    private static PreparationProposal Proposal() => new(
        "harbor",
        [new("harbor", "雾港", "雾港的旧灯室", "雾港等待调查。",
            [new PreparationEvidence("sourceText", 0, 2, "雾港")])],
        [], [], []);

    private static PreparationRequest Request(string requestId) => new(requestId,
        new PreparationInput(Source, "调查旧灯室", "雾港准备", "prepared-harbor", "1", false, null),
        new PreparationPrompt("prep", "1", "只整理主持提供的原文。"), true);

    private static string PathFor(string campaignId) => $"/api/v1/campaigns/{campaignId}/content/preparation";

    private static async Task<HttpResponseMessage> Send(Host host, HttpMethod method, string path, string? token,
        object? body = null)
    {
        using var message = new HttpRequestMessage(method, path);
        if (token is not null) message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (body is not null) message.Content = JsonContent.Create(body);
        return await host.Http.SendAsync(message);
    }

    public static async Task ConcurrentReceiptAndUnblockedReads()
    {
        string root = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "dicerealm-prep-concurrent-" + Id());
        string campaignId;
        string token;
        var request = Request(Id());
        PreparationResult confirmed;
        var generator = new BlockingGenerator();
        await using (var host = await Host.Start(root, configure: b => b.Services.AddSingleton<IPreparationGenerator>(generator)))
        {
            var created = await host.Create();
            campaignId = created.Snapshot.Id;
            token = created.AccessToken;
            var path = PathFor(campaignId);
            var campaignFile = System.IO.Path.Combine(root, "campaigns", campaignId + ".sqlite");
            var beforeCampaign = File.ReadAllBytes(campaignFile);
            var first = host.Http.PostAsJsonAsync(path, request);
            Task<HttpResponseMessage>? duplicate = null;
            try
            {
                await generator.Entered.WaitAsync(WaitLimit);
                Check.Equal(1, generator.Calls);
                duplicate = host.Http.PostAsJsonAsync(path, request);
                // A persisted unknown receipt is already readable while the provider is still blocked.
                var inFlight = await host.Http.GetFromJsonAsync<PreparationResult>(path + "/requests/" + request.RequestId)
                    .WaitAsync(WaitLimit);
                Check.Equal("unknown", inFlight!.Status);
                // These share the campaign, but must NOT wait for the preparation catalog's provider gate.
                var snapshot = await host.Get(campaignId).WaitAsync(WaitLimit);
                Check.Equal(created.Snapshot.Version, snapshot!.Version);
                var status = await host.Http.GetFromJsonAsync<PreparationStatus>(path + "/status").WaitAsync(WaitLimit);
                Check.True(status!.Enabled);
                Check.True(!first.IsCompleted, "the first HTTP response must still be waiting on the fake provider");
                Check.True(!duplicate.IsCompleted, "the duplicate HTTP request must still be in flight");
            }
            finally { generator.Release(); }

            using var firstResponse = await first.WaitAsync(WaitLimit);
            using var duplicateResponse = await duplicate!.WaitAsync(WaitLimit);
            Check.Equal(HttpStatusCode.OK, firstResponse.StatusCode);
            Check.Equal(HttpStatusCode.OK, duplicateResponse.StatusCode);
            confirmed = (await firstResponse.Content.ReadFromJsonAsync<PreparationResult>())!;
            var replay = (await duplicateResponse.Content.ReadFromJsonAsync<PreparationResult>())!;
            Check.Equal("ready", confirmed.Status);
            Check.Equal(JsonSerializer.Serialize(confirmed), JsonSerializer.Serialize(replay));
            Check.Equal(1, generator.Calls);
            Check.True(beforeCampaign.SequenceEqual(File.ReadAllBytes(campaignFile)),
                "preparation must not write the live campaign even during a concurrent request");
        }

        // Reopen the same isolated directory with a different provider; both lookup and POST use
        // the durable result, and the replacement provider must not be invoked.
        var restart = new CountingGenerator();
        await using (var host = await Host.Start(root, configure: b => b.Services.AddSingleton<IPreparationGenerator>(restart)))
        {
            host.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
            var path = PathFor(campaignId);
            var lookup = await host.Http.GetFromJsonAsync<PreparationResult>(path + "/requests/" + request.RequestId);
            Check.Equal(JsonSerializer.Serialize(confirmed), JsonSerializer.Serialize(lookup));
            using var result = await host.Http.PostAsJsonAsync(path, request);
            Check.Equal(HttpStatusCode.OK, result.StatusCode);
            Check.Equal(JsonSerializer.Serialize(confirmed),
                JsonSerializer.Serialize(await result.Content.ReadFromJsonAsync<PreparationResult>()));
            Check.Equal(0, restart.Calls);
        }
    }

    public static async Task GuestAndForeignCannotInspectOrGenerate()
    {
        var generator = new CountingGenerator();
        await using var host = await Host.Start(configure: b => b.Services.AddSingleton<IPreparationGenerator>(generator));
        var owner = await host.Create();
        var campaignId = owner.Snapshot.Id;
        var path = PathFor(campaignId);
        var request = Request(Id());
        using (var prepared = await host.Http.PostAsJsonAsync(path, request))
        {
            Check.Equal(HttpStatusCode.OK, prepared.StatusCode);
            Check.Equal("ready", (await prepared.Content.ReadFromJsonAsync<PreparationResult>())!.Status);
        }
        Check.Equal(1, generator.Calls);
        var invite = new InviteRequest(Id(), owner.Snapshot.Version, new string('a', 64));
        using (var invitation = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaignId}/invitations", invite))
            Check.Equal(HttpStatusCode.OK, invitation.StatusCode);
        using var joined = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaignId}/join",
            new JoinCampaignRequest(Id(), invite.InviteToken, new string('b', 64), "Guest", Build: FullCreationTests.Named("Guest")));
        Check.Equal(HttpStatusCode.OK, joined.StatusCode);
        var guest = (await joined.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        var foreign = await host.Create("Other");
        // Host.Create sets a default bearer; remove it so the null-token case is actually anonymous.
        host.Http.DefaultRequestHeaders.Authorization = null;
        var catalogFile = System.IO.Path.Combine(host.Root, "preparation", campaignId + ".json");
        var campaignFile = System.IO.Path.Combine(host.Root, "campaigns", campaignId + ".sqlite");
        var catalogBefore = File.ReadAllBytes(catalogFile);
        var campaignBefore = File.ReadAllBytes(campaignFile);
        var inspect = new PreparationInspectRequest(request.Input, Proposal());

        foreach (var (token, denied) in new (string? Token, HttpStatusCode Status)[]
        {
            (null, HttpStatusCode.Unauthorized),
            (guest.AccessToken, HttpStatusCode.Forbidden),
            (foreign.AccessToken, HttpStatusCode.Unauthorized)
        })
        {
            using var status = await Send(host, HttpMethod.Get, path + "/status", token);
            Check.Equal(denied, status.StatusCode);
            using var receipt = await Send(host, HttpMethod.Get, path + "/requests/" + request.RequestId, token);
            Check.Equal(denied, receipt.StatusCode);
            using var replay = await Send(host, HttpMethod.Post, path, token, request);
            Check.Equal(denied, replay.StatusCode);
            using var fresh = await Send(host, HttpMethod.Post, path, token, Request(Id()));
            Check.Equal(denied, fresh.StatusCode);
            using var inspected = await Send(host, HttpMethod.Post, path + "/inspect", token, inspect);
            Check.Equal(denied, inspected.StatusCode);
        }
        Check.Equal(1, generator.Calls);
        Check.True(catalogBefore.SequenceEqual(File.ReadAllBytes(catalogFile)), "denied requests changed preparation receipts");
        Check.True(campaignBefore.SequenceEqual(File.ReadAllBytes(campaignFile)), "denied requests changed the campaign");
    }
}
