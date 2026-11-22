using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class MapTests
{
    public static async Task Run()
    {
        await using var host = await Host.Start();
        var s = (await host.Create()).Snapshot;
        Check.Equal(1, s.Map.Nodes.Length); Check.Equal("current", s.Map.Nodes[0].State);
        Check.Equal(0, s.Map.Edges.Length);
        Check.True(!JsonSerializer.Serialize(s.Map).Contains("beacon"));
        s = (await host.Act(s, "talk")).Snapshot;
        Check.Equal(2, s.Map.Nodes.Length);
        Check.True(s.Map.Nodes.Single(n => n.Id == "causeway").CanTravel);
        Check.True(s.Map.Nodes.All(n => n.Id != "beacon"));
        var travel = new ActionRequest(Guid.NewGuid().ToString(), s.Version, "travel", "causeway");
        var moved = (await (await host.Send(s.Id, travel)).Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.Equal("causeway", moved.Snapshot.Scene.Id);
        Check.Equal(3, moved.Snapshot.Map.Nodes.Length);
        Check.Equal("discovered", moved.Snapshot.Map.Nodes.Single(n => n.Id == "beacon").State);
        var replay = (await (await host.Send(s.Id, travel)).Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(replay.Replayed); Check.Equal(moved.Snapshot.Version, replay.Snapshot.Version);
        Check.Equal(HttpStatusCode.Conflict, (await host.Send(s.Id, new(Guid.NewGuid().ToString(), s.Version, "travel", "beacon"))).StatusCode);
        s = (await host.Act(moved.Snapshot, "travel", "beacon")).Snapshot;
        Check.Equal("visited", s.Map.Nodes.Single(n => n.Id == "harbor").State);
        Check.True(!s.Map.Nodes.Single(n => n.Id == "harbor").CanTravel);
        Check.True(s.Map.Nodes.Where(n => n.CanTravel).Select(n => n.Id).SequenceEqual(s.AvailableActions.Where(a => a.Kind == "travel").Select(a => a.Target)));
        // Known topology survives leaving a visited place; only current exits authorize travel.
        Check.True(s.Map.Edges.Select(e => e.From + ">" + e.To).ToHashSet().SetEquals(
            ["harbor>causeway", "causeway>harbor", "causeway>beacon", "beacon>causeway"]));
        Check.Equal("causeway", s.Map.Nodes.Single(n => n.CanTravel).Id);
        Check.Equal(HttpStatusCode.Conflict, (await host.Send(s.Id, new(Guid.NewGuid().ToString(), s.Version, "travel", "harbor"))).StatusCode);
        Check.Equal(s.Version, (await host.Get(s.Id))!.Version);
        s = (await host.Act(s, "talk")).Snapshot;
        Check.Equal("重燃的灯室", s.Map.Nodes.Single(n => n.Id == "beacon").Title);
        Check.Equal("beacon", (await host.Get(s.Id))!.Map.Nodes.Single(n => n.State == "current").Id);
    }
}
