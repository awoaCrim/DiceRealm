using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class InitialAdventureTests
{
    private static string Id() => Guid.NewGuid().ToString();
    public static async Task SetupAfterRoomCreationPreservesSeatsAndReplays()
    {
        var model = new HarnessTests.Model((_, _) => throw new Exception("Setup must not invoke providers"));
        var h = await Host.Start(configure: HarnessTests.Configure(model));
        CreatedCampaign owner; InitializeRoomAdventureRequest request; string root = h.Root;
        try
        {
            var create = await h.Http.PostAsJsonAsync("/api/v1/rooms", new { name = "Blank room" });
            Check.Equal(HttpStatusCode.Created, create.StatusCode); owner = (await create.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            Check.True(owner.Snapshot.Character is null && owner.Snapshot.Content!.InitialSetup);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var guest = await HarnessBoundaryTests.Guest(h, owner);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var before = (await h.Get(owner.Snapshot.Id))!;
            request = new(Id(), before.Version, TestContent.Document, "  Original prompt\r\n原文  ", [new("method", "只读说明", "原始方法\r\n")]);
            string path = $"/api/v1/campaigns/{owner.Snapshot.Id}/adventure/setup";
            Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync(path, request with { Prompt = "" })).StatusCode);
            Check.Equal(before.Version, (await h.Get(owner.Snapshot.Id))!.Version);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{owner.Snapshot.Id}/content/activate", new ActivateContentRequest(Id(), before.Version))).StatusCode);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync(path, request)).StatusCode);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var response = await h.Http.PostAsJsonAsync(path, request); Check.Equal(HttpStatusCode.OK, response.StatusCode);
            var result = (await response.Content.ReadFromJsonAsync<ActionResponse>())!;
            Check.True(!result.Snapshot.Content!.InitialSetup); Check.Equal("active", result.Snapshot.Content.Status);
            Check.Equal(guest.Snapshot.Character!.Id, result.Snapshot.Party!.Members.Single().Character!.Id);
            Check.Equal(before.Party!.Members.Single().Review!.Status, result.Snapshot.Party.Members.Single().Review!.Status);
            Check.Equal(HttpStatusCode.OK, (await h.Http.GetAsync($"/api/v1/campaigns/{owner.Snapshot.Id}/adventure")).StatusCode);
            var workspace = await h.Http.GetFromJsonAsync<AdventureSettingsView>($"/api/v1/campaigns/{owner.Snapshot.Id}/adventure/settings");
            Check.Equal(request.Prompt, workspace!.Active.Prompt); Check.Equal(request.Methods[0].Content, workspace.Active.Methods[0].Content);
            Check.True((await (await h.Http.PostAsJsonAsync(path, request)).Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(path, request with { RequestId = Id(), ExpectedVersion = result.Snapshot.Version })).StatusCode);
            Check.Equal(0, model.Calls);
        }
        finally { await h.DisposeAsync(); }
        await using var restart = await Host.Start(root, configure: HarnessTests.Configure(model));
        restart.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var replay = await restart.Http.PostAsJsonAsync($"/api/v1/campaigns/{owner.Snapshot.Id}/adventure/setup", request);
        Check.Equal(HttpStatusCode.OK, replay.StatusCode); Check.True((await replay.Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
        Check.Equal(0, model.Calls);
    }
    public static async Task LegacyBlankNeverImplicitlyConverts()
    {
        await using var h = await Host.Start(configure: HarnessTests.Configure(new HarnessTests.Model((_, _) => throw new Exception("No calls"))));
        var created = (await (await h.Http.PostAsJsonAsync("/api/v1/campaigns", new { name = "Old blank" })).Content.ReadFromJsonAsync<CreatedCampaign>())!;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", created.AccessToken);
        Check.True(!created.Snapshot.Content!.InitialSetup);
        var result = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{created.Snapshot.Id}/adventure/setup", new InitializeRoomAdventureRequest(Id(), created.Snapshot.Version, TestContent.Document, "explicit", []));
        Check.Equal(HttpStatusCode.Conflict, result.StatusCode); Check.Equal(created.Snapshot.Version, (await h.Get(created.Snapshot.Id))!.Version);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.GetAsync($"/api/v1/campaigns/{created.Snapshot.Id}/adventure")).StatusCode);
    }
}
