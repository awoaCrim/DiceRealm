using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

// Opt-in temporary real-service fixture: no production profiles, no provider credentials.
internal static class PlayerActionsBrowserFixture
{
    public static async Task Run(string statePath)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop")) throw new InvalidOperationException("Use a fresh fixture path.");
        string root = Path.Combine(Path.GetTempPath(), "dicerealm-player-actions-" + Guid.NewGuid());
        var dice = new SequenceDice(2, 3, 4, 2, 3, 4);
        await using var h = await Host.Start(root, dice, configure: b =>
        {
            foreach (string prefix in new[] { "TextAi", "ImageAi", "HarnessAi", "PreparationAi" })
            { b.Configuration[prefix + ":ApiKey"] = ""; b.Configuration[prefix + ":Model"] = ""; }
        });
        var doc = TestContent.Document with { Items = [..TestContent.Document.Items,
            new("qa-potion", "治疗药水", NaturalActions.HealingPotion),
            ..Enumerable.Range(1, 36).Select(i => new ContentItem("qa-item-" + i, "旅途纪念物 " + i + " · Journey keepsake"))] };
        var response = await h.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("[隔离验证] 玩家直结算与队伍休整", "埃兰 · Arden", CharacterEngine.Fighter, doc, TestContent.Prompts, StartImmediately: true, Build: FullCreationTests.Named("埃兰 · Arden")));
        Check.Equal(HttpStatusCode.Created, response.StatusCode);
        var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        string id = owner.Snapshot.Id, invitation = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/invitations", new InviteRequest(Guid.NewGuid().ToString(), owner.Snapshot.Version, invitation));
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/join", new JoinCampaignRequest(Guid.NewGuid().ToString(), invitation, Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)), "莉雅 · Lyra", CharacterEngine.Fighter, Build: FullCreationTests.Named("莉雅 · Lyra", CharacterEngine.Wizard)));
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        var guest = await h.ApproveGuest(owner, (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!);
        // Seed this newly created temporary campaign only. Subsequent QA uses production APIs.
        await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, c =>
        {
            c.Character = PlayResources.Ensure(c.Character.Required()) with { HitPoints = 1,
                Inventory = [..c.Character.Inventory, new("qa-potion", "治疗药水", 3, false), ..Enumerable.Range(1, 36).Select(i => new Item("qa-item-" + i, "旅途纪念物 " + i + " · Journey keepsake", i, false))] };
            var ch = c.PartyMembers.Single(m => m.Id == guest.Snapshot.Party!.SelfActorId).Character;
            PartyEngine.SetCharacter(c, guest.Snapshot.Party!.SelfActorId, PlayResources.Ensure(ch) with { HitPoints = 1 });
            return Task.FromResult(true);
        });
        string address = h.Http.BaseAddress!.GetLeftPart(UriPartial.Authority);
        JsonFiles.Write(statePath, new { baseUrl = address, dataPath = root, processId = Environment.ProcessId, campaignId = id });
        JsonFiles.Write(statePath + ".connection.json", new { baseUrl = address, campaignId = id, accessToken = owner.AccessToken });
        JsonFiles.Write(statePath + ".guest.json", new { baseUrl = address, campaignId = id, accessToken = guest.AccessToken });
        Console.WriteLine("Isolated player actions fixture ready; real HTTP, providers disabled.");
        await Observe(statePath, dice);
    }

    public static async Task Resume(string statePath, string previousState)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop")) throw new InvalidOperationException("Use a fresh fixture path.");
        using var state = JsonDocument.Parse(File.ReadAllText(previousState));
        string root = Path.GetFullPath(state.RootElement.GetProperty("dataPath").GetString()!);
        string address = state.RootElement.GetProperty("baseUrl").GetString()!;
        string id = state.RootElement.GetProperty("campaignId").GetString()!;
        if (!Path.GetDirectoryName(root)!.Equals(Path.TrimEndingDirectorySeparator(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase)
            || !Path.GetFileName(root).StartsWith("dicerealm-player-actions-", StringComparison.Ordinal) || !Directory.Exists(root)
            || !Uri.TryCreate(address, UriKind.Absolute, out var uri) || !uri.IsLoopback || uri.Scheme != "http")
            throw new InvalidOperationException("Only the isolated player-actions fixture may resume.");
        var dice = new SequenceDice(2, 3, 4, 2, 3, 4);
        await using var host = await Host.Start(root, dice, configure: builder =>
        {
            builder.WebHost.UseUrls(address);
            foreach (string prefix in new[] { "TextAi", "ImageAi", "HarnessAi", "PreparationAi" })
            { builder.Configuration[prefix + ":ApiKey"] = ""; builder.Configuration[prefix + ":Model"] = ""; }
        });
        foreach (string suffix in new[] { ".connection.json", ".guest.json" }) File.Copy(previousState + suffix, statePath + suffix);
        JsonFiles.Write(statePath, new { baseUrl = address, dataPath = root, processId = Environment.ProcessId, campaignId = id });
        Console.WriteLine("Resumed isolated fixture without reseeding characters or history; providers disabled.");
        await Observe(statePath, dice);
    }

    private static async Task Observe(string statePath, SequenceDice dice)
    {
        while (!File.Exists(statePath + ".stop"))
        {
            try { JsonFiles.Write(statePath + ".stats", new { diceCount = dice.Count, actualProvider = "disabled" }); }
            // A diagnostic reader on Windows may momentarily deny replacement. This is only
            // fixture telemetry: do not tear down the HTTP host or retry any game operation.
            catch (IOException error) when ((error.HResult & 0xffff) is 32 or 33)
            { Console.WriteLine("QA telemetry reader is busy; the next sample will retry."); }
            await Task.Delay(200);
        }
    }
}
