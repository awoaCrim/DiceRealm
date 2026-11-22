using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class PreparationBoundaryTests
{
    public static Task PublicKnowledgeContext()
    {
        var campaign = new Campaign
        {
            Id = Guid.NewGuid().ToString(), Name = "test", TokenHash = "test", Adventure = TestContent.Document, Prompts = TestContent.Prompts,
            ContentActivated = true, SceneId = "harbor", ActingActorId = PartyEngine.HostId,
            Character = StarterCharacter.Create("Host")
        };
        campaign.VisitedScenes.Add("harbor");
        campaign.WorldMemory.AddRange([
            new("private", "clue", "Host only", "PREP_PRIVATE_SENTINEL", "known", "", 1, 0, 1, "host", "preparation", Visibility:"host"),
            new("late", "npc", "Not arrived", "PREP_FUTURE_SENTINEL", "known", "", 1, 0, 1, "host", "preparation", Visibility:"arrival", RevealSceneId:"causeway"),
            new("open", "clue", "Public", "Allowed source", "known", "harbor", 1, 0, 1, "host", "preparation"),
            new("hidden", "clue", "Hidden", "PREP_HIDDEN_SENTINEL", "known", "", 1, 0, 1, "host", "preparation", Hidden:true)
        ]);
        var intent = IntentContexts.Build(campaign, "Talk", [], []);
        var context = AdventureDirecting.Build(campaign, intent);
        Check.Equal(1, context.KnownMemory.Length);
        Check.Equal("open", context.KnownMemory[0].Id);
        Check.True(!JsonSerializer.Serialize(context).Contains("SENTINEL"), "even the host's ordinary player input must not send private imported knowledge");
        Check.Equal(4, WorldMemories.View(campaign).Length);
        campaign.PartyMembers.Add(new PartyMember { Id="guest",TokenHash="guest-test",Character=StarterCharacter.Create("Guest") });
        campaign.ActingActorId = "guest";
        Check.Equal(1, WorldMemories.View(campaign).Length);
        campaign.VisitedScenes.Add("causeway");
        Check.Equal(2, WorldMemories.Public(campaign).Length);
        var plan = WorldMemories.Plan(campaign, [new("late","npc","Not arrived","Updated public account","known", "")],
            new HashSet<string>{"late"}, new HashSet<string>{"harbor","causeway"}, 2, "ai");
        Check.Equal("arrival", plan[0].Visibility); Check.Equal("causeway", plan[0].RevealSceneId);
        Check.Throws<GameException>(() => WorldMemories.Plan(campaign, [new("private","clue","Host only","Forged public update","known", "")],
            new HashSet<string>{"private"}, new HashSet<string>{"harbor"}, 2, "ai"));
        return Task.CompletedTask;
    }
    private sealed class Wire(string raw) : HttpMessageHandler
    {
        public int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(new {choices=new[]{new {message=new {content=raw}}}}) });
        }
    }
    public static async Task StrictProviderAndClarification()
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string,string?>
        { ["DataPath"]=Path.Combine(Path.GetTempPath(),"prep-boundary-"+Guid.NewGuid()), ["TextAi:Model"]="fake", ["TextAi:ApiKey"]="fake-not-secret", ["TextAi:Endpoint"]="http://127.0.0.1:1" }).Build();
        using var directory = new DataDirectory(configuration); var budget = new ProviderBudget(directory, configuration);
        string campaign=Guid.NewGuid().ToString();
        const string valid = """{"startSceneId":"a","scenes":[{"id":"a","title":"A","summary":"a","arrival":"","evidence":[{"field":"sourceText","start":0,"length":1,"quote":"a"}]}],"routes":[],"knowledge":[],"questions":[]}""";
        foreach (string raw in new[] {
            valid.Replace("\"title\":", "\"title\":\"shadowed\",\"title\":"),
            valid.Replace("\"scenes\":", "\"Scenes\":"),
            valid.Replace("\"start\":0,", ""), // Missing numerical source offset must not silently become zero.
            valid.Replace("\"title\":", "\"Title\":") })
        {
            var wire=new Wire(raw);var generator=new OpenAiPreparation(new HttpClient(wire),configuration,budget);
            bool rejected=false;try{await generator.Generate(new("a","","author prompt"),default,campaign);}catch(JsonException){rejected=true;}
            Check.True(rejected,"ambiguous provider JSON must be rejected");Check.Equal(1,wire.Calls);
        }
        Check.Equal(4,budget.Read("text",campaign,true).Total);
        var boundedWire=new Wire(valid);var bounded=new OpenAiPreparation(new HttpClient(boundedWire),configuration,budget);
        bool tooLarge=false;try{await bounded.Generate(new(new string('x',100000),"",new string('p',32768)),default,campaign);}catch(InvalidDataException){tooLarge=true;}
        Check.True(tooLarge);Check.Equal(0,boundedWire.Calls);Check.Equal(4,budget.Read("text",campaign,true).Total);
        var input = new PreparationInput("a","","Title","test","1",false,null);
        var empty = new PreparationProposal("",[],[],[],["Where does this happen?"]);
        var outcome=PreparationProjection.Project(input,empty);
        Check.Equal("needs_clarification",outcome.Status);Check.True(outcome.Document is null);
        var parsed=JsonSerializer.Deserialize<PreparationProposal>(valid,JsonFiles.Options)!;
        outcome=PreparationProjection.Project(input,parsed with {StartSceneId=""});
        Check.Equal("needs_clarification",outcome.Status);Check.True(outcome.Issues.Any(i=>i.Path=="startSceneId"));
        Check.Throws<GameException>(()=>PreparationProjection.ValidatePrompt(new("p","1"," \r\n")));

        // Offline inspection enforces the same mandatory fields as provider output.
        var fake=new Generator();await using var host=await Host.Start(configure:b=>b.Services.AddSingleton<IPreparationGenerator>(fake));
        var created=await host.Create();string path=$"/api/v1/campaigns/{created.Snapshot.Id}/content/preparation";
        var inspected=JsonSerializer.SerializeToNode(new PreparationInspectRequest(input,parsed),JsonFiles.Options)!;
        using(var ok=await host.Http.PostAsync(path+"/inspect",new StringContent(inspected.ToJsonString(),System.Text.Encoding.UTF8,"application/json")))
            Check.Equal(HttpStatusCode.OK,ok.StatusCode);
        inspected["proposal"]!["scenes"]![0]!["evidence"]![0]!.AsObject().Remove("start");
        using(var missing=await host.Http.PostAsync(path+"/inspect",new StringContent(inspected.ToJsonString(),System.Text.Encoding.UTF8,"application/json")))
            Check.Equal(HttpStatusCode.BadRequest,missing.StatusCode);
        var generated=JsonSerializer.SerializeToNode(new PreparationRequest(Guid.NewGuid().ToString(),input,new("p","1","authored"),true),JsonFiles.Options)!;
        generated["input"]!.AsObject().Remove("startSafeRest");
        using(var missing=await host.Http.PostAsync(path,new StringContent(generated.ToJsonString(),System.Text.Encoding.UTF8,"application/json")))
            Check.Equal(HttpStatusCode.BadRequest,missing.StatusCode);
        Check.Equal(0,fake.Calls);Check.Equal(created.Snapshot.Version,(await host.Get(created.Snapshot.Id))!.Version);

    }
    private sealed class Generator : IPreparationGenerator
    {
        public int Calls;public bool Enabled=>true;public string Model=>"fake";
        public Task<PreparationProposal> Generate(PreparationGenerationRequest request,CancellationToken ct,string campaignId)
        { Calls++;return Task.FromResult(new PreparationProposal("",[],[],[],["Missing setting"])); }
    }
    public static async Task ArchivedAndCorruptCatalog()
    {
        var generator=new Generator();await using var host=await Host.Start(configure:b=>b.Services.AddSingleton<IPreparationGenerator>(generator));
        var created=await host.Create();string path=$"/api/v1/campaigns/{created.Snapshot.Id}/content/preparation";
        var request=new PreparationRequest(Guid.NewGuid().ToString(),new("a","","T","test","1",false,null),new("p","1","authored"),true);
        var first=await host.Http.PostAsJsonAsync(path,request);Check.Equal(HttpStatusCode.OK,first.StatusCode);
        var saved=await first.Content.ReadFromJsonAsync<PreparationResult>();
        var archive=await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{created.Snapshot.Id}/archive",new ArchiveCampaignRequest(Guid.NewGuid().ToString(),created.Snapshot.Version,true));
        Check.Equal(HttpStatusCode.OK,archive.StatusCode);
        Check.True(!(await host.Http.GetFromJsonAsync<PreparationStatus>(path+"/status"))!.Enabled);
        var replay=await host.Http.PostAsJsonAsync(path,request);Check.Equal(HttpStatusCode.OK,replay.StatusCode);
        Check.Equal(saved!.InputHash,(await replay.Content.ReadFromJsonAsync<PreparationResult>())!.InputHash);
        Check.Equal(HttpStatusCode.Conflict,(await host.Http.PostAsJsonAsync(path,request with {RequestId=Guid.NewGuid().ToString()})).StatusCode);
        Check.Equal(1,generator.Calls);
        string catalog=Path.Combine(host.Root,"preparation",created.Snapshot.Id+".json");
        foreach(string damaged in new[]{"{}","{\"schemaVersion\":2,\"records\":[]}","{\"schemaVersion\":1,\"records\":null}"})
        {
            await File.WriteAllTextAsync(catalog,damaged);
            Check.Equal(HttpStatusCode.InternalServerError,(await host.Http.PostAsJsonAsync(path,request)).StatusCode);
            Check.Equal(damaged,await File.ReadAllTextAsync(catalog));Check.Equal(1,generator.Calls);
        }
    }
}
