using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;
using static DiceRealm.Tests.AutomaticMapTests;

namespace DiceRealm.Tests;

internal static class SceneMapStatusTests
{
    public static Task CatalogStatesAreReadOnly()
    {
        string root=Path.Combine(Path.GetTempPath(),"dicerealm-map-status-"+Id());
        var config=AssetTests.Config(new(){["DataPath"]=root});using var data=new DataDirectory(config);
        var images=new TestImages();var maps=new MapCatalog(data,images,new SceneReferences(data),config);
        string campaign=Id(),actor=Id();
        SceneMapStatus State(bool enabled=true,string scene="harbor")=>CatalogCall<SceneMapStatus>(maps,"SceneStatus",campaign,scene,enabled);
        Check.Equal(new SceneMapStatus("harbor","missing",true),State());
        Check.Equal(new SceneMapStatus("harbor","unavailable",false),State(false));
        Check.Equal(new SceneMapStatus("","unavailable",false),State(scene:""));
        Check.Equal(0,Directory.GetFiles(Path.Combine(root,"maps"),"*.json",SearchOption.AllDirectories).Length);
        var spec=AssetTests.Spec() with{Grid=new(){Uncalibrated=true}};
        var receipt=CatalogCall<AutomaticMapResponse>(maps,"RequestAutomatic",campaign,"harbor",1,actor,Id(),Id(),spec);
        Check.Equal("pending",State().Status);Check.Equal("pending",State(false).Status);Check.True(!State(false).GenerationEnabled);
        string file=Directory.GetFiles(Path.Combine(root,"maps"),"*.json",SearchOption.AllDirectories).Single(),before=File.ReadAllText(file);
        for(int i=0;i<3;i++)Check.Equal("pending",State().Status);
        Check.Equal(before,File.ReadAllText(file));Check.Equal(0,images.Calls);
        var job=maps.Claim()!;Check.Equal("generating",State().Status);maps.Fail(job,"fixture-failure");Check.Equal("failed",State().Status);Check.True(maps.Claim() is null);
        // A published hand-authored player image wins even while an old automatic attempt failed.
        var manual=maps.Create(campaign,AssetTests.Create(AssetTests.Spec("manual")));
        manual=maps.ConfigureScenes(campaign,manual.Id,new(Id(),manual.Version,["harbor"]),["harbor"]);
        maps.Generate(campaign,manual.Id,AssetTests.Generate(manual));maps.Complete(maps.Claim()!,AssetTests.Png);
        manual=maps.Get(campaign,manual.Id,true);manual=maps.Publish(campaign,manual.Id,new(Id(),manual.Version,true,true));
        Check.Equal("ready",State().Status);Check.Equal(new SceneMapStatus("harbor","ready",false),State(false));
        maps.Publish(campaign,manual.Id,new(Id(),manual.Version,false,false));Check.Equal("failed",State().Status);
        // Finish an automatic job under another scene to exercise withheld without requeue.
        var second=CatalogCall<AutomaticMapResponse>(maps,"RequestAutomatic",campaign,"beacon",1,actor,Id(),Id(),spec with{Prompt="other"});
        maps.Complete(maps.Claim()!,AssetTests.Png);var ready=maps.Get(campaign,second.Map.Id,true);
        maps.Publish(campaign,ready.Id,new(Id(),ready.Version,false,false));Check.Equal("withheld",State(scene:"beacon").Status);Check.True(maps.Claim() is null);
        var json=HarnessJson.Element(State());Check.True(json.EnumerateObject().Select(p=>p.Name).Order().SequenceEqual(new[]{"generationEnabled","sceneId","status"}));
        return Task.CompletedTask;
    }
    public static async Task PublicReadFramesAndExecutionBoundary()
    {
        var model=new Model((_,_)=>throw new Exception("Read must not invoke a model"));var images=new TestImages();
        await using var h=await Host.Start(images:images,configure:Configure(model));var owner=await Create(h);
        var game=h.App.Services.GetRequiredService<GameService>();var store=h.App.Services.GetRequiredService<CampaignStore>();
        var auth=await game.AuthorizeHarness(owner.Snapshot.Id,owner.AccessToken,default);
        string route=$"/api/v1/campaigns/{owner.Snapshot.Id}/maps?publishedOnly=true";
        string database=Path.Combine(h.Root,"campaigns",owner.Snapshot.Id+".sqlite");byte[] before=File.ReadAllBytes(database);
        for(int i=0;i<3;i++)
        {
            var library=(await h.Http.GetFromJsonAsync<MapLibraryView>(route))!;Check.Equal(new SceneMapStatus("harbor","missing",true),library.Status);Check.Equal(0,library.Maps.Length);
            var frame=await game.ReadHarnessExecution(owner.Snapshot.Id,owner.AccessToken,auth.ActorId,Id(),"巡视港口",auth.Version,default,22);
            Check.Equal(library.Status,frame.Map);Check.True(frame.AvailableTools.Contains("map_request"));
            foreach(var state in new[]{"unavailable","missing","pending","generating","ready","failed","withheld"})
            foreach(bool enabled in new[]{false,true})
            {
                if(state=="unavailable"&&enabled)continue;
                var projected=HarnessExecutionProtocol.Capture(frame.Version,frame.Context,frame.Combat,frame.Self,22,new("harbor",state,enabled));
                HarnessExecutionProtocol.Validate(projected,frame.Version,22);
                Check.Equal(state=="missing"&&enabled,projected.AvailableTools.Contains("map_request"));
            }
            foreach(int version in new[]{15,19,20,21})
            {
                var old=await game.ReadHarnessExecution(owner.Snapshot.Id,owner.AccessToken,auth.ActorId,Id(),"巡视港口",auth.Version,default,version);
                HarnessExecutionProtocol.Validate(old,old.Version,version);Check.True(!HarnessJson.Element(old).TryGetProperty("map",out _));
                Check.Throws<InvalidDataException>(()=>HarnessExecutionProtocol.Validate(old with{Map=frame.Map},old.Version,version));
            }
            Check.Throws<InvalidDataException>(()=>HarnessExecutionProtocol.Validate(frame with{Map=frame.Map! with{SceneId="hidden"}},frame.Version,22));
        }
        Check.True(before.SequenceEqual(File.ReadAllBytes(database)));Check.Equal(0,images.Calls);Check.Equal(0,model.Calls);
        var catalog=h.App.Services.GetRequiredService<MapCatalog>();
        var manual=catalog.Create(owner.Snapshot.Id,AssetTests.Create());manual=catalog.ConfigureScenes(owner.Snapshot.Id,manual.Id,new(Id(),manual.Version,["harbor"]),["harbor"]);
        catalog.Generate(owner.Snapshot.Id,manual.Id,AssetTests.Generate(manual));await AssetTests.Until(()=>Task.FromResult(catalog.Get(owner.Snapshot.Id,manual.Id,true).Status=="ready"));
        manual=catalog.Get(owner.Snapshot.Id,manual.Id,true);catalog.Publish(owner.Snapshot.Id,manual.Id,new(Id(),manual.Version,true,true));
        var files=Directory.GetFiles(Path.Combine(h.Root,"maps"),"*.json",SearchOption.AllDirectories).ToDictionary(p=>p,File.ReadAllText);
        var denied=await game.HarnessTool(owner.Snapshot.Id,owner.AccessToken,auth.ActorId,Id(),"巡视",auth.Version,Id(),Id(),new("map_request",HarnessJson.Element(new{kind="region"}),"unexpected"),[],default,auth.Profile,22,true);
        Check.Equal("refresh_required",JsonDocument.Parse(denied.Reply.Content).RootElement.GetProperty("protocol").GetProperty("phase").GetString());
        Check.Equal(files.Count,Directory.GetFiles(Path.Combine(h.Root,"maps"),"*.json",SearchOption.AllDirectories).Length);
        foreach(var file in files)Check.Equal(file.Value,File.ReadAllText(file.Key));Check.Equal(1,images.Calls);Check.Equal(0,model.Calls);
        foreach(bool archived in new[]{false,true})
        {
            await store.Access(owner.Snapshot.Id,owner.AccessToken,true,c=>{c.Archived=archived;typeof(Campaign).GetProperty(nameof(Campaign.OfflineTrial))!.SetValue(c,!archived);return Task.FromResult(0);},default);
            var library=(await h.Http.GetFromJsonAsync<MapLibraryView>(route))!;Check.Equal(new SceneMapStatus("harbor","ready",false),library.Status);Check.True(!library.GenerationEnabled);Check.Equal(1,library.Maps.Length);
        }
    }
}
