using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessHistoryTests
{
    private static PendingIntent Intent(string actor, int sequence, string text, bool privateRoot = false) => new()
    {
        Id = Id(), ActorId = actor, RootSequence = sequence, Version = sequence + 1, Text = text,
        Source = "harness", Published = true, PrivateRoot = privateRoot, Status = "completed",
        Result = new("narrated", "adventure.narrate", "已记录", null, []), NarrativeSource = "harness"
    };
    private static GameEvent Event(PendingIntent intent, int sequence, string narrative, PrivateStoryMessage[]? privateMessages = null) =>
        new(Id(), sequence, "adventure.narrate", "已记录", narrative, "harness", DateTimeOffset.UtcNow,
            intent.Result! with { IntentId = intent.Id }, intent.ActorId, PrivateMessages: privateMessages);
    private static T Body<T>(JsonElement value)
    {
        var body = System.Text.Json.Nodes.JsonNode.Parse(value.GetRawText())!.AsObject();
        body.Remove("protocol");
        return HarnessJson.Read<T>(HarnessJson.Element(body));
    }
    private static void Error(string code, Action action)
    {
        try { action(); throw new Exception("Expected " + code); }
        catch (GameException ex) { Check.Equal(code, ex.Code); }
    }

    public static Task SourcePartsClosureAndPublicAudience()
    {
        var c = TestContent.Campaign("harbor", "历史边界"); c.Version = 40;
        string owner = c.ActingActorId, peer = "guest";
        var shared = Intent(peer, 2, "另一位角色说：我可以考虑，但还没有接受。");
        var privateRoot = Intent(peer, 5, "PEER-PRIVATE-INPUT", privateRoot: true);
        var unfinished = Intent(peer, 8, "UNFINISHED-INPUT"); unfinished.Status = "pending";
        var current = Intent(owner, 10, "CURRENT-INPUT");
        var draft = Intent(peer, 12, "UNPUBLISHED-INPUT"); draft.Published = false;
        shared.Continuity = [new("promise", "PEER-PRIVATE-NOTE")];
        var noted = Intent(owner, 14, "保留交涉事项");
        noted.Continuity = [new("promise", "只在修桥后考虑，未答应。"), new("open_question", "对方尚未回答何时回来。")];
        c.PendingIntents.AddRange([shared, privateRoot, unfinished, current, draft, noted]);
        string ours = Id(), theirs = Id(), common = Id();
        var mixed = Event(shared, 3, "商人声称桥边安全；角色并未答应今晚出发。",
            [new(ours, [owner], "仅本人知道的条件。"), new(theirs, [peer], "PEER-PRIVATE-BODY"), new(common, [owner, peer], "两人共同知道，但尚未公开。")]);
        var secret = Event(privateRoot, 5, "", [new(Id(), [peer], "PEER-ROOT-BODY")]);
        var publishedLater = Event(privateRoot, 6, "后来公开说了一句话。");
        var host = Event(shared, 7, "HOST-ONLY") with { HostOnly = true };
        var waiting = Event(unfinished, 9, "UNFINISHED-RESULT");
        var ownCurrent = Event(current, 11, "CURRENT-RESULT");
        var unpublished = Event(draft, 13, "UNPUBLISHED-RESULT");
        var events = new[] { mixed, secret, publishedLater, host, waiting, ownCurrent, unpublished };
        c.AdventureCorrections.Add(new(shared.RootSequence, "更正：桥边尚未确认安全。", "HOST-REASON", owner, DateTimeOffset.UtcNow, 20));
        var sources = HarnessHistorySources.Capture(c, events, current.Id);
        string serialized = HarnessJson.Serialize(sources);
        foreach (string omitted in new[] { "PEER-PRIVATE", "PEER-ROOT", "HOST-ONLY", "HOST-REASON", "UNFINISHED", "CURRENT-", "UNPUBLISHED" })
            Check.True(!serialized.Contains(omitted), omitted);
        Check.True(sources.Any(s => s.Kind == "player_input" && s.Text == shared.Text && s.Audience == "public"));
        Check.True(sources.Any(s => s.Text == publishedLater.Narrative && s.Audience == "public"));
        Check.True(sources.Any(s => s.Source.Part == "private:" + ours && s.Audience == owner));
        Check.True(sources.Any(s => s.Source.Part == "private:" + common && s.Audience == owner));
        Check.True(sources.All(s => s.Source.Part != "private:" + theirs));
        Check.True(sources.Any(s => s.Text == mixed.Narrative)); // immutable original remains available
        Check.True(sources.Any(s => s.Kind == "published_correction_of_intent:" + shared.Id));
        var source = sources.Single(s => s.Source.Part == "narrative" && s.Source.Id == mixed.Id);
        Check.Equal(source.Text, HarnessHistorySources.Expand(c.Version, sources, new(source.Source)).Text);
        Error("harness_memory_unavailable", () => HarnessHistorySources.Expand(c.Version, sources, new(source.Source with { Revision = new string('0', 64) })));
        Error("harness_memory_unavailable", () => HarnessHistorySources.Expand(c.Version, sources,
            new(new("event", mixed.Id, mixed.Sequence, "private:" + theirs, PrivateStories.Revision("PEER-PRIVATE-BODY")))));
        var note = sources.Single(s => s.Kind == "model_reported_promise");
        Check.Equal(owner, note.Audience); Check.Equal(noted.Id, note.Source.Id);
        Check.Equal("只在修桥后考虑，未答应。", HarnessHistorySources.Expand(c.Version, sources, new(note.Source)).Text);
        Check.True(sources.Any(s => s.Kind == "model_reported_open_question" && s.Audience == owner));
        var page = HarnessHistorySources.Search(c.Version, null, sources, new("可以考虑"));
        Check.True(page.Entries.Any(s => s.Source.Kind == "intent" && s.Source.Id == shared.Id));
        Check.Equal(0, HarnessHistorySources.Search(c.Version, null, sources, new("PEER-PRIVATE-BODY")).Total);
        var unicode = source with { Text = "甲😀乙", Source = source.Source with { Revision = PrivateStories.Revision("甲😀乙") } };
        Check.Equal("甲", HarnessHistorySources.Expand(c.Version, [unicode], new(unicode.Source, Limit: 2)).Text);
        Check.Equal("😀", HarnessHistorySources.Expand(c.Version, [unicode], new(unicode.Source, 1, 2)).Text);
        Error("harness_invalid_payload", () => HarnessHistorySources.Expand(c.Version, [unicode], new(unicode.Source, 2)));
        return Task.CompletedTask;
    }

    public static Task StoryEligibilityAndExactSettledResults()
    {
        var c = TestContent.Campaign("harbor", "历史用途"); c.Version = 60;
        string owner = c.ActingActorId;
        var admin = new[] { "content.draft", "content.adventure", "content.prompts", "content.initial-adventure",
            "party.invite", "party.join", "party.revoke", "party.revoke_invite", "party.room", "character.review", "character.resubmit" }
            .Select((kind, index) => new GameEvent(Id(), index + 1, kind, "ADMIN-当时等待审核", "", "system", DateTimeOffset.UtcNow,
                new("resolved", kind, "ADMIN-当时等待审核", null, []), owner)).ToArray();
        var arrival = new GameEvent(Id(), 20, "content.activate", "你来到了旧码头。", "", "system", DateTimeOffset.UtcNow,
            new("resolved", "content.activate", "你来到了旧码头。", null, []), owner);
        var check = new DiceCheck("dexterity", "Stealth", [4], 4, 2, 6, 10, false, "normal");
        var result = new GameEvent(Id(), 21, "check", "行动检定已完成", "", "harness", DateTimeOffset.UtcNow,
            new("resolved", "check", "行动检定已完成", check, []), owner);
        var logs = new[] {
            new CombatEntry(1, 1, "move", owner, "PUBLIC-MOVE", null, null),
            new CombatEntry(2, 1, "damage", "known", "OWN-RESULT-19", null, null) { Audience = [owner] },
            new CombatEntry(3, 1, "attack", "secret", "PEER-SECRET", null, null) { Audience = ["peer"] } };
        var combat = new GameEvent(Id(), 22, "combat.attack", "PUBLIC-MOVE\nOWN-RESULT-19\nPEER-SECRET", "", "harness", DateTimeOffset.UtcNow,
            new("resolved", "combat.attack", "PUBLIC-MOVE\nOWN-RESULT-19\nPEER-SECRET", null, [], CombatLog: logs), owner);
        var events = admin.Concat(new[] { arrival, result, combat }).ToArray();
        string before = HarnessJson.Serialize(events);
        var legacy = HarnessHistorySources.Capture(c, events, toolContractVersion: 50);
        Check.True(legacy.Any(s => s.Text.Contains("ADMIN-")));
        var current = HarnessHistorySources.Capture(c, events, toolContractVersion: 51);
        Check.True(current.All(s => !s.Text.Contains("ADMIN-")));
        Check.True(current.Any(s => s.Source.Id == arrival.Id && s.Text == arrival.Text));
        var precise = current.Single(s => s.Source.Id == result.Id);
        Check.True(precise.Text.Contains("\"total\":6") && precise.Text.Contains("\"dc\":10"));
        Check.Equal(precise.Text, HarnessHistorySources.Expand(c.Version, current, new(precise.Source), 51).Text);
        Check.Equal(0, HarnessHistorySources.Search(c.Version, null, current, new("ADMIN-"), 51).Total);
        Check.True(!HarnessJson.Serialize(current.Where(s => s.Audience == "public")).Contains("OWN-RESULT"));
        Check.True(!HarnessJson.Serialize(current).Contains("PEER-SECRET"));
        Check.True(current.Any(s => s.Audience == owner && s.Text.Contains("OWN-RESULT-19")));
        Check.Equal(before, HarnessJson.Serialize(events));
        // Old mixed publication is retained but cannot pull excluded management back in.
        var adminSource = legacy.First(s => s.Source.Id == admin[0].Id);
        var storySource = legacy.Single(s => s.Source.Id == arrival.Id);
        var mixed = new HarnessHistorySummary(Id(), 1, 1, "exploration", "public", [adminSource.Source, storySource.Source],
            "ADMIN-MIXED", "ADMIN-MIXED", []);
        var capture = new HarnessHistoryCapture("", "exploration", current, [mixed]);
        var context = HarnessHistoryContexts.Build(c.Version, owner, capture, "继续冒险", [], toolContractVersion: 51);
        HarnessHistoryContexts.Validate(context, c.Version, owner, "exploration", 51);
        Check.True(context.Audiences.All(a => a.Summaries.Length == 0));
        Check.True(context.Audiences.SelectMany(a => a.Raw).Any(s => s.Source == storySource.Source));
        Check.True(!HarnessJson.Serialize(context).Contains("ADMIN-"));
        Check.True(context.Notice.Contains("截至该段历史"));
        Check.Equal(HarnessHistoryContexts.Notice, HarnessHistoryContexts.Build(c.Version, owner,
            new("", "exploration", legacy, []), "", [], toolContractVersion: 50).Notice);
        return Task.CompletedTask;
    }

    public static async Task PublicPeerSearchAndExactExpansionThroughPi()
    {
        string expected = "来客声称认识看守；若桥修好才考虑带路，目前没有接受委托。";
        HarnessHistorySource? found = null; string peerId = "";
        var model = new Model((n, request) =>
        {
            if (n == 1) return Tool("ctx_search", new { query = "来客" });
            if (n == 2)
            {
                using var output = JsonDocument.Parse(request.Messages.Last(m => m.Name == "ctx_search").Content);
                var page = Body<HarnessHistorySearchResult>(output.RootElement);
                var fragment = page.Entries.Single(s => s.Text == expected);
                Check.Equal(peerId, fragment.ActorId); Check.Equal("public", fragment.Audience);
                found = fragment.Source;
                return Tool("ctx_expand", new { source = found, limit = 10 });
            }
            if (n == 3)
            {
                using var output = JsonDocument.Parse(request.Messages.Last(m => m.Name == "ctx_expand").Content);
                var body = Body<HarnessHistoryExpanded>(output.RootElement);
                Check.Equal(expected[..10], body.Text); Check.Equal(10, body.NextOffset!.Value);
                return Tool("ctx_expand", new { source = found, offset = body.NextOffset.Value });
            }
            using var last = JsonDocument.Parse(request.Messages.Last(m => m.Name == "ctx_expand").Content);
            Check.Equal(expected[10..], last.RootElement.GetProperty("text").GetString());
            return Tool("world_record", new NarrativeHarnessArgs("已找到原话，尚未接受委托。", []));
        });
        var dice = new SequenceDice();
        await using var h = await Host.Start(dice: dice, configure: Configure(model, extra: builder =>
        {
            builder.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            builder.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        }));
        var owner = await Create(h); string id = owner.Snapshot.Id;
        var invite = new InviteRequest(Id(), owner.Snapshot.Version, new string('a', 64));
        await Post<ActionResponse>(h, id, "invitations", invite);
        var guest = await Post<CreatedCampaign>(h, id, "join", new JoinCampaignRequest(Id(), invite.InviteToken, new string('b', 64), "来客", Build: FullCreationTests.Named("来客")));
        guest = await h.ApproveGuest(owner, guest); peerId = guest.Snapshot.Party!.SelfActorId;
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        await store.Access(id, owner.AccessToken, true, c =>
        {
            var intent = Intent(peerId, c.Version + 1, "来客想了解委托");
            c.PendingIntents.Add(intent);
            c.Events.Add(Event(intent, ++c.Version, expected, [new(Id(), [peerId], "NEVER-TO-HOST-MODEL")]));
            c.Events.Add(Event(intent, ++c.Version, "此事暂告一段落。"));
            return Task.FromResult(true);
        });
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var snapshot = (await h.Get(id))!;
        var input = new HarnessInputRequest(Id(), snapshot.Version, "回顾来客提出的条件");
        var run = await Post<HarnessRunView>(h, id, "harness/runs", input);
        // This path starts a real SDK worker; use the existing real-Pi observation
        // window rather than the fake-loop 12s polling default (product deadline unchanged).
        run = await Settled(h, id, run.Id, maximumPolls: 3000);
        Check.True(run.Status == "completed", run.Status + "/" + run.Error);
        Check.Equal(4, model.Calls); Check.Equal(0, dice.Count);
        Check.Equal(snapshot.Version + 1, run.Version);
        var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
        Check.True(saved.Steps.Where(s => s.ToolName is "ctx_search" or "ctx_expand").All(s => s.Outcome!.Version == snapshot.Version));
        Check.True(!HarnessJson.Serialize(saved.Steps.Where(s => s.ToolName is "ctx_search" or "ctx_expand")).Contains("NEVER-TO-HOST-MODEL"));
        Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed);
        Check.Equal(4, model.Calls);
    }
}
