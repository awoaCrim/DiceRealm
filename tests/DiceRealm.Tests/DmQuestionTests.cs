using System.Net;
using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class DmQuestionTests
{
    public static async Task RealPiQuestionRestartAndMainInputAnswer()
    {
        const string question = "老板问：你希望今晚安静休息，还是找人聊聊？";
        const string answer = "我想安静休息，但先听听这里的规矩。";
        var dice = new SequenceDice(18);
        var model = new Model((call, request) => call == 1
            ? Tool("ask_player", new { question })
            : Tool("world_record", new NarrativeHarnessArgs("老板点头，开始介绍客栈的规矩。", [])));
        var configure = Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(h); string id = owner.Snapshot.Id, sessionId = Id();
            var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/adventure/actions", new AdventureActionRequest(sessionId, owner.Snapshot.Version, "我走到柜台前，向老板问好。"));
            Check.Equal(HttpStatusCode.Accepted, response.StatusCode);
            var waiting = await Settled(h, id, sessionId, maximumPolls: 3000);
            Check.Equal("waiting", waiting.Status); Check.Equal("player", waiting.Wait!.Kind); Check.Equal(1, model.Calls);
            var state = (await h.Get(id))!;
            Check.Equal(owner.Snapshot.Version, state.Version); Check.Equal(0, dice.Count);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var restored = (await h.Http.GetFromJsonAsync<AdventureSessionView>($"/api/v1/campaigns/{id}/adventure/sessions/{sessionId}"))!;
            Check.Equal("needsAnswer", restored.Phase); Check.Equal(question, restored.Question); Check.Equal(1, model.Calls);
            var continuation = new AdventureActionRequest(Id(), state.Version, answer);
            var resumed = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/adventure/sessions/{sessionId}/continue", continuation);
            Check.Equal(HttpStatusCode.Accepted, resumed.StatusCode);
            var done = await Settled(h, id, sessionId, maximumPolls: 3000);
            Check.Equal("completed", done.Status); Check.Equal(2, model.Calls); Check.Equal(0, dice.Count);
            Check.True(model.Requests.Last().Messages.Any(m => m.Content.Contains(HarnessJson.Serialize(new { playerAnswer = answer }))));
            var final = (await h.Get(id))!; Check.Equal(state.ElapsedSeconds, final.ElapsedSeconds);
            var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!.Entries.Single();
            Check.Equal(restored.ActionId, activity.ActionId); Check.Equal("老板点头，开始介绍客栈的规矩。", activity.Narrative);
            // The answer is on record with the action it continues; the DM's question stays with this seat.
            Check.Equal("我走到柜台前，向老板问好。", activity.Origin!.Input);
            Check.Equal(HarnessJson.Serialize(new[] { new IntentClarification("", answer) }), HarnessJson.Serialize(activity.Origin.Clarifications));
            Check.True(!HarnessJson.Serialize(activity).Contains(question));
            await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/adventure/sessions/{sessionId}/continue", continuation);
            Check.Equal(2, model.Calls); Check.Equal(0, dice.Count);
        }
        finally { await h.DisposeAsync(); }
    }
}
