using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

// Explicit isolated setup for the real clients. The player still joins with the actual wizard,
// receives host approval through the workbench, and submits its action through the Player UI.
internal static class KnowledgeBrowserFixture
{
    public static async Task Run(string statePath)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop")) throw new InvalidOperationException("Use a fresh fixture path.");
        var model = new Model((_, request) =>
        {
            var frame = HarnessExecutionProtocolTests.Frame(request);
            string actor = frame.GetProperty("self").GetProperty("actorId").GetString()!;
            return Tool("world_record", KnowledgeVisibilityTests.Story("",
                KnowledgeVisibilityTests.Message([actor, PartyEngine.HostId],
                    "你们一起读完信件：北坡的老榆树下有人等候。信封背面另写着一句口令——雨落无声。口信尚未向其他同伴公开。")));
        });
        var dice = new SequenceDice();
        await using var h = await Host.Start(dice: dice, configure: Configure(model, extra: builder =>
        {
            builder.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            builder.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        }));
        AccountTests.SeedAdminFixture(h);
        var owner = await Create(h); var peer = await HarnessBoundaryTests.Guest(h, owner);
        string id = owner.Snapshot.Id;
        await KnowledgeVisibilityTests.Record(h, owner, KnowledgeVisibilityTests.Story("",
            KnowledgeVisibilityTests.Message([peer.Snapshot.Party!.SelfActorId], "旁观席位的私人对照：钟楼里的密谈。不可发给新加入者。")));
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var snapshot = (await h.Get(id))!;
        await Post<ActionResponse>(h, id, "room", new ConfigureRoomRequest(Id(), snapshot.Version, true, "knowledge-ui-fixture"));
        var room = await h.Http.GetFromJsonAsync<RoomView>($"/api/v1/campaigns/{id}/room");
        JsonFiles.Write(statePath, new
        {
            baseUrl = h.Http.BaseAddress!.GetLeftPart(UriPartial.Authority), dataPath = h.Root, processId = Environment.ProcessId,
            campaignId = id, hostToken = owner.AccessToken, peerToken = peer.AccessToken,
            roomNumber = room!.RoomNumber, sharedPassword = "knowledge-ui-fixture", fixture = "knowledge-real-pi-isolated-text-model"
        });
        Console.WriteLine("Knowledge UI fixture ready: isolated room; new player joins through normal UI; no paid provider.");
        while (!File.Exists(statePath + ".stop"))
        {
            JsonFiles.Write(statePath + ".stats", new { dice = dice.Count, modelCalls = model.Calls, paidProviderCalls = 0 });
            await Task.Delay(500);
        }
        JsonFiles.Write(statePath + ".result", new { dice = dice.Count, modelCalls = model.Calls, paidProviderCalls = 0 });
    }
}
