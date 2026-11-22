using System.Net;
using System.Net.Http.Json;
using System.Text;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

// Actor-only story channel: privateText reaches only the acting seat and the host.
internal static class PrivateStoryTests
{
    private const string HostSecret = "PRIVATE_STORY_HOST_SENTINEL", GuestSecret = "PRIVATE_STORY_GUEST_SENTINEL",
        HostText = HostSecret + "\n第二行";
    private static readonly string[] Paths = ["", "/events?after=0&limit=100", "/journal?after=0&limit=100", "/activity?after=0&limit=100"];
    private static string Id() => Guid.NewGuid().ToString();
    private static void Auth(Host h, string token) => h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
    private static string Url(string id, string path) => $"/api/v1/campaigns/{id}{path}";

    private static async Task<string> RawBodies(Host h, string token, string id)
    {
        Auth(h, token); var all = new StringBuilder();
        foreach (string path in Paths) all.Append(await h.Http.GetStringAsync(Url(id, path)));
        return all.ToString();
    }
    // Every non-empty privateText a viewer can read through snapshot, /events, /journal and /activity.
    private static async Task<string[]> Visible(Host h, string token, string id)
    {
        Auth(h, token); var all = new List<string>();
        var s = (await h.Get(id))!;
        all.AddRange(s.Events.Select(e => e.PrivateText)); all.AddRange(s.PendingRulings.Select(r => r.PrivateText));
        all.AddRange((await h.Http.GetFromJsonAsync<GameEvent[]>(Url(id, Paths[1])))!.Select(e => e.PrivateText));
        all.AddRange((await h.Http.GetFromJsonAsync<JournalPage>(Url(id, Paths[2])))!.Events.Select(e => e.PrivateText));
        foreach (var entry in (await h.Http.GetFromJsonAsync<ActivityPage>(Url(id, Paths[3])))!.Entries)
        { all.Add(entry.PrivateText); all.Add(entry.Ruling?.PrivateText ?? ""); }
        return all.Where(x => x.Length > 0).Distinct().Order().ToArray();
    }
    private static async Task Isolated(Host h, CreatedCampaign owner, CreatedCampaign guest, string id)
    {
        Check.True(!(await RawBodies(h, guest.AccessToken, id)).Contains(HostSecret), "Host private text escaped to another seat");
        Check.Equal(GuestSecret, string.Join("|", await Visible(h, guest.AccessToken, id)));
        Check.Equal(string.Join("|", new[] { GuestSecret, HostText }.Order()), string.Join("|", await Visible(h, owner.AccessToken, id)));
        Auth(h, owner.AccessToken);
        string export = await h.Http.GetStringAsync(Url(id, "/journal/export"));
        Check.True(export.Contains(HostSecret) && export.Contains(GuestSecret));
    }

    public static async Task HarnessWorldRecord()
    {
        var model = new HarnessTests.Model((_, _) => throw new Exception("No model call expected"));
        var h = await Host.Start(configure: HarnessTests.Configure(model));
        var owner = await HarnessTests.Create(h); var guest = await HarnessBoundaryTests.Guest(h, owner);
        string id = owner.Snapshot.Id; var game = h.App.Services.GetRequiredService<GameService>();
        async Task<HarnessToolOutcome> Record(CreatedCampaign who, int contract, NarrativeHarnessArgs args, string tool = "world_record")
        {
            var auth = await game.AuthorizeHarness(id, who.AccessToken, default);
            return await game.HarnessTool(id, who.AccessToken, auth.ActorId, Id(), "私密测试", auth.Version, Id(), Id(),
                new(tool, HarnessJson.Element(args), "call"), [], default, auth.Profile, contract, contextAlreadyRead: true);
        }
        async Task Rejected(Func<Task> call) { try { await call(); throw new Exception("Expected rejection"); } catch (GameException ex) { Check.Equal("harness_invalid_payload", ex.Code); } }
        // Catalog: v15 stays frozen without the field, v16 adds only world_record.private (max 1024).
        string Property(int v) => HarnessTools.ForVersion(v).Single(t => t.Name == "world_record").InputSchema.GetProperty("properties").GetRawText();
        Check.True(!Property(15).Contains("\"private\""));
        Check.True(Property(16).Contains("\"private\":{\"type\":\"string\",\"maxLength\":1024}"));
        Check.Equal(HarnessTools.ForVersion(15).Length, HarnessTools.ForVersion(16).Length);
        await Rejected(() => Record(owner, 15, new("v15 不接受私密字段。", [], "不能写入")));
        await Rejected(() => Record(owner, 16, new("过长。", [], new string('x', 1025))));
        await Rejected(() => Record(owner, 16, new("控制字符。", [], "bell\u0007")));
        await Rejected(() => Record(owner, 16, new("final 不接受。", [], "不能写入"), "narrative_commit"));
        Check.Equal(0, (await Visible(h, owner.AccessToken, id)).Length);
        // Whitespace-only private text is no private text.
        await Record(owner, 16, new("只有公开叙事。", [], "  "));
        Check.Equal(0, (await Visible(h, owner.AccessToken, id)).Length);
        await Record(owner, 16, new("主持席位的公开叙事。", [], HostSecret + "\n第二行"));
        await Record(guest, 16, new("队友席位的公开叙事。", [], GuestSecret));
        async Task Verify(Host host)
        {
            Check.True(!(await RawBodies(host, guest.AccessToken, id)).Contains(HostSecret));
            Check.Equal(GuestSecret, string.Join("|", await Visible(host, guest.AccessToken, id)));
            var all = await Visible(host, owner.AccessToken, id); Check.Equal(2, all.Length);
            Check.True(all.Contains(HostSecret + "\n第二行") && all.Contains(GuestSecret));
            Auth(host, owner.AccessToken); string export = await host.Http.GetStringAsync(Url(id, "/journal/export"));
            Check.True(export.Contains(HostSecret) && export.Contains(GuestSecret));
            // Public fields never carry the private text.
            foreach (var e in (await host.Get(id))!.Events)
                Check.True(!(e.Text + e.Narrative + e.Resolution?.Summary).Contains("SENTINEL"));
        }
        await Verify(h);
        string root = h.Root; await h.DisposeAsync();
        h = await Host.Start(root, configure: HarnessTests.Configure(model));
        await Verify(h); await h.DisposeAsync();
    }

    public static async Task DmRulingPrivateText()
    {
        var dice = new SequenceDice(15); var h = await Host.Start(dice: dice);
        var owner = await h.Create(); string id = owner.Snapshot.Id; var guest = await HarnessBoundaryTests.Guest(h, owner);
        // Host-seat ruling: the guest is the other seat and must never see it.
        Auth(h, owner.AccessToken); var s = (await h.Get(id))!;
        s = (await h.Act(s, "natural", text: "我想感受一下那面旗帜")).Snapshot;
        var hostRuling = s.PendingRulings.Single(r => r.Status == "pending");
        var request = new ResolveRulingRequest(Id(), s.Version, hostRuling.Id, "narrative", "只记录叙事", "本场主持裁定");
        foreach (string bad in new[] { new string('长', 1001), "bell\u0007", "tab\there" })
        {
            var rejected = await h.Http.PostAsJsonAsync(Url(id, "/rulings/resolve"), request with { RequestId = Id(), PrivateText = bad });
            Check.Equal(HttpStatusCode.BadRequest, rejected.StatusCode); Check.True((await rejected.Content.ReadAsStringAsync()).Contains("invalid_ruling"));
        }
        var done = await h.Http.PostAsJsonAsync(Url(id, "/rulings/resolve"), request with { PrivateText = HostText });
        Check.Equal(HttpStatusCode.OK, done.StatusCode); var settled = (await done.Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(!settled.Resolution.Summary.Contains(HostSecret)); Check.Equal(HostText, settled.Snapshot.PendingRulings.Single(r => r.Id == hostRuling.Id).PrivateText);
        // Guest-seat ruling: requested roll first, so the text must survive awaiting_roll and the final settle.
        Auth(h, guest.AccessToken); var g = (await h.Get(id))!;
        g = (await h.Act(g, "natural", text: "我悄悄摸一下口袋")).Snapshot;
        var guestRuling = g.PendingRulings.Single(r => r.Status == "pending");
        Auth(h, owner.AccessToken); s = (await h.Get(id))!;
        var ask = new ResolveRulingRequest(Id(), s.Version, guestRuling.Id, "check", "感知检定", "XPHB 2024 / Ability Checks", "wisdom", "Perception", 12, PrivateText: GuestSecret);
        var asked = await h.Http.PostAsJsonAsync(Url(id, "/rulings/respond"), ask); Check.Equal(HttpStatusCode.OK, asked.StatusCode);
        var waiting = (await asked.Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.Equal("awaiting_roll", waiting.Resolution.Status); Check.True(!waiting.Resolution.Summary.Contains(GuestSecret));
        Check.True(!waiting.Snapshot.PendingRoll?.Description.Contains(GuestSecret) ?? true);
        Auth(h, guest.AccessToken); g = (await h.Get(id))!;
        Check.True(g.PendingRoll is not null && !g.PendingRoll.Description.Contains(GuestSecret));
        Check.Equal(GuestSecret, g.PendingRulings.Single(r => r.Id == guestRuling.Id).PrivateText);
        var rolled = await h.Http.PostAsJsonAsync(Url(id, "/rolls/respond"), new RollResponseRequest(Id(), g.Version, g.PendingRoll!.Id, "roll"));
        Check.Equal(HttpStatusCode.OK, rolled.StatusCode); Check.Equal(1, dice.Count);
        var final = (await rolled.Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(!final.Resolution.Summary.Contains(GuestSecret));
        Check.Equal("resolved", final.Snapshot.PendingRulings.Single(r => r.Id == guestRuling.Id).Status);
        Check.True(!JsonSerialize(final.Snapshot.Events).Contains(GuestSecret) && !JsonSerialize(final.Snapshot.Events).Contains(HostSecret));
        await Isolated(h, owner, guest, id);
        string root = h.Root; await h.DisposeAsync();
        h = await Host.Start(root, dice); await Isolated(h, owner, guest, id); await h.DisposeAsync();
    }
    private static string JsonSerialize<T>(T value) => System.Text.Json.JsonSerializer.Serialize(value);
}
