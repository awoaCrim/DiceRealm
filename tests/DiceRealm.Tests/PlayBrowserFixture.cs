using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

// Opt-in fixture for the browser player page (/play/): isolated DataPath, real Pi, fake model only.
// Each action asks for one DC15 Athletics check on the harbor steps, then narrates; it proves the page's
// consent, roll and continue path, not free-language judgment.
// The host creates a harness campaign, opens the room, and approves a guest who joined with a full
// build. The guest's private seat connection is written to the state file; "<state>.stop" ends it.
// The room stays open: the state file also carries its number, password and the host token, so a
// browser tour can join a second player through the page's builder and approve it as the host would.
internal static class PlayBrowserFixture
{
    // opening: the adventure declares an entry, so each seat's page sends its own opening first.
    public static async Task Run(string statePath, bool opening = false)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop")) throw new InvalidOperationException("Use a fresh fixture path.");
        var dice = new SequenceDice(14, 6, 17);
        var model = new Model((_, request) =>
        {
            if (request.Tools.Any(t => t.Name == "opening_commit"))
            {
                var frame = HarnessExecutionProtocolTests.Frame(request);
                string who = frame.GetProperty("self").GetProperty("name").GetString()!;
                return Tool("opening_commit", new OpeningNarrativeArgs(frame.GetProperty("opening").GetProperty("writePublic").GetBoolean()
                    ? who + "站在门旁，雨水顺着檐角落下，码头上的灯一盏盏亮起。" : "", "你想起了路上的雨声，尚未答应任何委托。"));
            }
            // An action asking "哪条路" first gets the host's question, so a tour can walk the answer path.
            using (var initial = JsonDocument.Parse(request.Messages.First(m => m.Role == "user").Content))
                if (initial.RootElement.GetProperty("input").GetString()!.Contains("哪条路") && !request.Messages.Any(m => m.Role == "tool" && m.Name == "ask_player"))
                    return Tool("ask_player", new { question = "雨里有两条路：码头的石阶，和鱼市后的窄巷。你要走哪一条？" });
            if (!request.Messages.Any(m => m.Role == "tool" && m.Name == "check_request"))
                return Tool("check_request", NarrativeCheckTests.Proposed());
            string name = HarnessExecutionProtocolTests.Frame(request).GetProperty("self").GetProperty("name").GetString()!;
            return Tool("world_record", new NarrativeHarnessArgs(name + "踏稳湿滑的石阶，松动的碎石从门框落下，擦着肩头滚进雨里。", [],
                Private: "你注意到门框上方的石缝里卡着半截锈蚀的钥匙。"));
        });
        await using var h = await Host.Start(dice: dice, configure: Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        }));
        var owner = await Create(h, opening ? NarrativeCheckTests.Document with { Opening = new("harbor", ["harbor"]) } : NarrativeCheckTests.Document);
        string id = owner.Snapshot.Id;
        var room = (await h.Http.GetFromJsonAsync<RoomView>($"/api/v1/campaigns/{id}/room"))!;
        const string password = "fixture-play-password";
        await Ok(h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/room", new ConfigureRoomRequest(Guid.NewGuid().ToString(), room.Version, true, password)));
        string number = (await h.Http.GetFromJsonAsync<RoomView>($"/api/v1/campaigns/{id}/room"))!.RoomNumber;
        string token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var join = await Ok(h.Http.PostAsJsonAsync("/api/v1/rooms/join",
            new JoinRoomRequest(number, password, Guid.NewGuid().ToString(), token, FullCreationTests.Named("米洛"))));
        var guest = (await join.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        var current = (await h.Http.GetFromJsonAsync<CampaignSnapshot>($"/api/v1/campaigns/{id}", JsonFiles.Options))!;
        var member = current.Party!.Members.Single(m => m.Id == guest.Snapshot.Party!.SelfActorId);
        await Ok(h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/characters/review",
            new ReviewCharacterRequest(Guid.NewGuid().ToString(), current.Version, member.Id, member.Review!.Revision, "approve", "隔离验证")));
        string baseUrl = h.Http.BaseAddress!.GetLeftPart(UriPartial.Authority);
        JsonFiles.Write(statePath, new { baseUrl, campaignId = id, accessToken = guest.AccessToken, roomNumber = number, password, hostToken = owner.AccessToken, dataPath = h.Root,
            processId = Environment.ProcessId, fixture = "play-real-pi-fake-model" });
        Console.WriteLine("Play fixture ready: " + baseUrl + "/play/ (guest seat in the state file; fake model, no paid provider).");
        while (!File.Exists(statePath + ".stop"))
        {
            JsonFiles.Write(statePath + ".stats", new { dice = dice.Count, modelCalls = model.Calls, paidProviderCalls = 0 });
            await Task.Delay(500);
        }
    }
    private static async Task<HttpResponseMessage> Ok(Task<HttpResponseMessage> request)
    {
        var response = await request;
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException((int)response.StatusCode + " " + await response.Content.ReadAsStringAsync());
        return response;
    }
}
