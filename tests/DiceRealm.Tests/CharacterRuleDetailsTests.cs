using System.Text.Json;
using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class CharacterRuleDetailsTests
{
    private static LocalRuleEntry Entry(string id, string category, string name, string text) =>
        new(id, category, "规则夹具·" + name, name, [], text, "XPHB", 1, BuildCatalog.Revision, new string('a',64), "translated");
    private static LocalRulesPackage Package(params LocalRuleEntry[] entries) => new(1,"dnd2024","zh-CN",BuildCatalog.Revision,["XPHB"],
        new(false,false,["synthetic"],new[]{"spell","class","subclass","feature","species","background","feat","equipment","magic_item","monster","condition","rule","language"}
            .ToDictionary(c=>c,c=>new LocalRulesCount(entries.Count(e=>e.Category==c),entries.Count(e=>e.Category==c)))),entries);

    public static Task Projection()
    {
        var campaign=TestContent.Campaign("harbor");
        campaign.Character=BuildEvaluator.Create(FullCreationTests.Complete("fighter","human","soldier")) with
        {Features=["Second Wind","archery","Fighting Style","Resourceful","unknown","Improved Second Wind","agonizing-blast/eldritch-blast"]};
        var sheet=CharacterPlayEngine.View(campaign); string before=JsonSerializer.Serialize(sheet);
        var package=Package(
            Entry("class-feature:fighter:1:xphb:second-wind","feature","Second Wind","当前战士规则夹具"),
            Entry("class-feature:fighter:20:xphb:second-wind","feature","Second Wind","不能泄入的未来等级夹具"),
            Entry("class-feature:fighter:1:xphb:fighting-style","feature","Fighting Style","战士战斗风格夹具"),
            Entry("class-feature:paladin:2:xphb:fighting-style","feature","Fighting Style","不能串入的圣武士夹具"),
            Entry("feat:xphb:archery","feat","Archery","远程武器攻击检定+2测试文本"),
            Entry("species:xphb:human","species","Human","物种全文夹具"),
            Entry("optional-feature:xphb:agonizing-blast","feature","Agonizing Blast","祈唤正文夹具"),
            Entry("equipment:xphb:robe","equipment","Robe","价格：1 gp\n重量：4磅\n长袍属性夹具"),
            Entry("equipment:xphb:scholar-s-pack","equipment","Scholar's Pack","学者套装内容夹具"));
        sheet=sheet with {Character=sheet.Character with {Inventory=[new("robe","自定义显示名",1,false),new("scholars-pack","Scholar's Pack",1,false),new("story-item:robe","Robe",1,false)]}};
        before=JsonSerializer.Serialize(sheet);
        var result=CharacterRuleDetails.Project(sheet,package);
        Check.Equal(2,result.ItemDetails!.Length);
        Check.True(result.ItemDetails.Single(i=>i.Id=="robe").Text.Contains("4磅"));
        Check.True(result.ItemDetails.Single(i=>i.Id=="scholars-pack").Text.Contains("内容"));
        Check.True(result.ItemDetails.All(i=>i.Id!="story-item:robe"),"Mutable same names do not bind rules");
        Check.Equal(before,JsonSerializer.Serialize(sheet));
        Check.Equal(5,result.FeatureDetails!.Length);
        Check.True(result.FeatureDetails.Single(e=>e.Index==6).Text.Contains("本角色绑定选择：Eldritch Blast"));
        Check.True(result.FeatureDetails.Single(e=>e.Index==6).Name.Contains("Eldritch Blast"));
        Check.True(result.FeatureDetails.Single(e=>e.Index==0).Text.Contains("当前战士规则"));
        Check.True(result.FeatureDetails.Single(e=>e.Index==1).Text.Contains("+2"));
        Check.Equal("职业能力",result.FeatureDetails.Single(e=>e.Index==0).Group);
        Check.Equal("专长",result.FeatureDetails.Single(e=>e.Index==1).Group);
        Check.Equal("物种能力",result.FeatureDetails.Single(e=>e.Index==3).Group);
        Check.Equal("",result.FeatureDetails.Single(e=>e.Index==3).Text);
        Check.True(result.FeatureDetails.Single(e=>e.Index==3).Notice.Contains("独立正文"));
        Check.True(!JsonSerializer.Serialize(result.FeatureDetails).Contains("不能"));
        Check.True(result.FeatureDetails.All(e=>e.Index!=4&&e.Index!=5),"No fuzzy matching of unknown or improved abilities");
        var wire=JsonSerializer.SerializeToElement(result.FeatureDetails,JsonFiles.Options)[0];
        Check.True(!wire.TryGetProperty("source",out _)&&!wire.TryGetProperty("page",out _));
        var oversized=CharacterRuleDetails.Project(sheet,Package(package.Entries[0] with{Text=new string('文',32769)}));
        Check.Equal("",oversized.FeatureDetails!.Single(e=>e.Index==0).Text);Check.True(oversized.FeatureDetails!.Single(e=>e.Index==0).Notice.Contains("超过"));
        var unconfigured=CharacterRuleDetails.Enrich(sheet,new LocalRulesCatalog(new ConfigurationBuilder().Build()));
        Check.Equal(0,unconfigured.FeatureDetails!.Length);Check.True(unconfigured.RuleDetailsNotice.Contains("未配置"));
        return Task.CompletedTask;
    }

    public static Task ItemFactsWithoutText()
    {
        var campaign = TestContent.Campaign("harbor");
        campaign.Character = campaign.Character! with { Inventory = [
            new("shield", "显示名不绑定", 4, false, "equipment:xphb:robe"),
            new("linked", "内容关联", 2, false), new("longsword", "显式未知", 1, false, "xphb:missing"),
            new("mystery", "Potion of Healing", 1, false)] };
        ContentItem[] content = [new("linked", "药水", "magic_item:xdmg:potion-of-healing"), new("shield", "不能覆盖库存身份", "equipment:xphb:chain-mail")];
        var sheet = CharacterPlayEngine.View(campaign) with { Wearables = new([], [], [
            new("absent", "magic_item:xdmg:amulet-of-health", "amulet", "离包仍同调", false, true, true, false, "not-carried")], [], 1) };
        string before = HarnessJson.Serialize(sheet);
        var result = CharacterRuleDetails.Project(sheet, null, "规则包未配置", content);
        Check.Equal(3, result.ItemDetails!.Length); Check.Equal("规则包未配置", result.RuleDetailsNotice);
        var robe = result.ItemDetails.Single(i => i.Id == "shield");
        Check.True(robe.HasWeight && robe.HasPrice); Check.Equal(4m, robe.WeightPounds); Check.Equal(100m, robe.PriceCp);
        Check.Equal("none", robe.Rarity); Check.Equal("", robe.Text); Check.Equal("gear", robe.Category);
        var potion = result.ItemDetails.Single(i => i.Id == "linked");
        Check.Equal("magic", potion.Category);
        Check.Equal(0.5m, potion.WeightPounds); Check.Equal(5000m, potion.PriceCp); Check.Equal("common", potion.Rarity);
        var absent = result.ItemDetails.Single(i => i.Id == "absent");
        Check.Equal(1m, absent.WeightPounds); Check.True(!absent.HasPrice); Check.Equal("rare", absent.Rarity);
        Check.Equal(before, HarnessJson.Serialize(sheet));
        Check.Equal(17m, InventoryWeight.Project(sheet.Character, content).TotalPounds);
        Check.Equal(2L, InventoryWeight.Project(sheet.Character, content).UnknownCount);
        Check.True(result.ItemDetails.All(i=>i.Id!="longsword"&&i.Id!="mystery"),"Explicit unknown identity and mutable names have no classification");
        var classified=CharacterRuleDetails.Project(sheet with {Wearables=null,Character=sheet.Character with {Inventory=[
            new("longsword","随意名字",1,false),new("shield","随意名字",1,false),new("thieves-tools","随意名字",1,false)]}},null).ItemDetails!;
        Check.Equal("weapon",classified.Single(i=>i.Id=="longsword").Category);
        Check.Equal("armor",classified.Single(i=>i.Id=="shield").Category);
        Check.Equal("tool",classified.Single(i=>i.Id=="thieves-tools").Category);
        var oversized = CharacterRuleDetails.Project(sheet, Package(Entry("equipment:xphb:robe", "equipment", "Robe", new string('文', 32769))), contentItems: content);
        var held = oversized.ItemDetails!.Single(i => i.Id == "shield");
        Check.Equal("", held.Text); Check.True(held.Notice.Contains("超过") && held.HasWeight && held.HasPrice);
        return Task.CompletedTask;
    }

    public static void RealMaintainedPackage(string directory)
    {
        var catalog=new LocalRulesCatalog(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string,string?>{{"LocalRules:Directory",directory}}).Build());
        foreach(string style in new[]{"archery","defense"})
        {
            var build=FullCreationTests.Complete("fighter","human","soldier");
            build=build with {Selections=build.Selections.Select(s=>s.Key=="class:fighter/style"?s with{Values=[style]}:s).ToArray()};
            var campaign=TestContent.Campaign("harbor");campaign.Character=BuildEvaluator.Create(build);
            var sheet=CharacterRuleDetails.Enrich(CharacterPlayEngine.View(campaign),catalog);
            int index=Array.IndexOf(sheet.Character.Features,style=="archery"?"Archery":"Defense");
            Check.True(index>=0);var detail=sheet.FeatureDetails!.Single(e=>e.Index==index);
            Check.True(detail.Text.Contains(style=="archery"?"+2":"+1"));
            var wind=sheet.FeatureDetails!.Single(e=>e.Index==Array.IndexOf(sheet.Character.Features,"Second Wind"));
            Check.True(wind.Text.Contains("1d10")&&wind.Text.Contains("短休")&&wind.Text.Contains("长休"));
            Check.True(sheet.RuleDetailsNotice=="");
        }
        var package=catalog.Read(catalog.CaptureVersion());
        foreach(var species in BuildCatalog.Get().Species)
        {
            var campaign=TestContent.Campaign("harbor");campaign.Character=BuildEvaluator.Create(FullCreationTests.Complete("fighter",species.Id,"soldier"));
            var sheet=CharacterRuleDetails.Enrich(CharacterPlayEngine.View(campaign),catalog);
            foreach(string feature in species.Features)
            {
                int index=Array.IndexOf(sheet.Character.Features,feature);
                var detail=sheet.FeatureDetails!.Single(e=>e.Index==index);
                Check.True(detail.Text.Length>0,species.Id+"/"+feature+" has a complete subtree");
                Check.True(!detail.Text.Contains("物种完整说明")&&!detail.Text.Contains("变体与血统选项"));
            }
            var vision=sheet.FeatureDetails!.FirstOrDefault(e=>e.Index==Array.IndexOf(sheet.Character.Features,"Darkvision"));
            if(vision is not null) Check.True(!vision.Text.Contains("恍惚")&&!vision.Text.Contains("吐息"));
            if(species.Id=="human")
            {
                var resourceful=sheet.FeatureDetails!.Single(e=>e.Index==Array.IndexOf(sheet.Character.Features,"Resourceful"));
                Check.Equal("机智",resourceful.Name);Check.Equal("物种能力",resourceful.Group);
                var refs=CharacterRuleDetails.References(sheet.Version,"player",campaign.Character,catalog);
                Check.Equal(JsonSerializer.Serialize(sheet.FeatureDetails),JsonSerializer.Serialize(refs.FeatureDetails));
                Check.True(resourceful.Text.Contains("英雄激励")&&!resourceful.Text.Contains("技能娴熟")&&!resourceful.Text.Contains("专长"));
            }
            if(species.Id=="elf")
            {
                Check.True(vision!.Text.Contains("120")&&!vision.Text.Contains("60"),"Drow vision overrides the base trait");
                var lineage=sheet.FeatureDetails!.Single(e=>e.Index==Array.IndexOf(sheet.Character.Features,"Elven Lineage"));
                Check.True(lineage.Text.Contains("妖火")&&lineage.Text.Contains("黑暗")&&lineage.Text.Contains("长休"));
                Check.True(!lineage.Text.Contains("迷踪步")&&!lineage.Text.Contains("德鲁伊伎俩"),"Only the acquired lineage is read");
            }
            var changed=package with {Entries=package.Entries.Select(e=>e.Id=="species:xphb:"+species.Id?e with{Text=e.Text+"\n译文变化"}:e).ToArray()};
            var guarded=CharacterRuleDetails.Project(CharacterPlayEngine.View(campaign),changed);
            Check.True(guarded.FeatureDetails!.Where(e=>species.Features.Contains(campaign.Character.Features[e.Index])).All(e=>e.Text==""),"Changed translation never reuses stale character offsets");
        }
        var multi=TestContent.Campaign("harbor");
        var initialSheet=CharacterPlayEngine.View(multi);
        multi.Character=BuildEvaluator.Create(FullCreationTests.Complete("fighter","human","soldier")) with
        {
            Level=20,Features=["Action Surge","Indomitable","Ability Score Improvement","ability-score-improvement","Unarmored Defense"],
            Advancement=new(1,BuildCatalog.Revision,[new("fighter",17,"",[],[],[],[]),new("barbarian",1,"",[],[],[],[]),new("monk",2,"",[],[],[],[])],[])
        };
        var grown=CharacterRuleDetails.Enrich(initialSheet with {Character=multi.Character},catalog).FeatureDetails!;
        Check.True(grown.Single(e=>e.Index==0).Text.Contains("17级"));
        Check.True(!grown.Single(e=>e.Index==0).Text.Contains("战士 ·"),"Identical source bodies appear once, not once per level");
        Check.True(grown.Single(e=>e.Index==1).Text.Contains("13级")&&grown.Single(e=>e.Index==1).Text.Contains("17级"));
        Check.True(!grown.Single(e=>e.Index==2).Text.Contains("专长类别"),"Class ASI must not absorb the ASI feat");
        Check.True(grown.Single(e=>e.Index==3).Text.Contains("专长类别"));
        var defense=grown.Single(e=>e.Index==4).Text;
        Check.True(defense.Contains("野蛮人")&&defense.Contains("武僧")&&defense.Contains("体质")&&defense.Contains("感知"),"Both acquired sources keep their own labels and formulas");
        var itemsCampaign=TestContent.Campaign("harbor");
        itemsCampaign.Character=itemsCampaign.Character! with {Inventory=[new("robe","Robe",1,false),new("dagger","Dagger",2,false),new("burglar-s-pack","Burglar's Pack",1,false)]};
        var items=CharacterRuleDetails.Enrich(CharacterPlayEngine.View(itemsCampaign),catalog).ItemDetails!;
        Check.True(items.Single(i=>i.Id=="robe").Text.Contains("4磅")&&items.Single(i=>i.Id=="robe").Text.Contains("1 gp"));
        Check.True(items.Single(i=>i.Id=="dagger").Text.Contains("1d4")&&items.Single(i=>i.Id=="dagger").Text.Contains("20/60"));
        Check.True(items.Single(i=>i.Id=="burglar-s-pack").Text.Contains("内容"));
        itemsCampaign.Adventure=itemsCampaign.Adventure! with {Items=[new("draught","重命名药剂",NaturalActions.HealingPotion),new("shield","别名", "equipment:xphb:robe"),new("mystery","看起来像长袍","xphb:unknown")]};
        itemsCampaign.Character=itemsCampaign.Character with {Inventory=[new("draught","故事药水",1,false),new("shield","外观盾牌",1,false),new("mystery","Robe",1,false),new("story-potion","Potion of Healing",1,false)]};
        var linked=CharacterRuleDetails.Enrich(CharacterPlayEngine.View(itemsCampaign),catalog,itemsCampaign.Adventure.Items).ItemDetails!;
        Check.Equal(2,linked.Length);Check.True(linked.Single(i=>i.Id=="draught").Text.Contains("2d4"));
        Check.True(linked.Single(i=>i.Id=="shield").Text.Contains("4磅")&&!linked.Single(i=>i.Id=="shield").Text.Contains("护甲等级"));
        Console.WriteLine("PASS character rule details: all 10 species, acquired lineage, exact class/feat ownership, source-identical growth, and explicit item rules identities");
    }

    public static async Task ReferencesHttp()
    {
        await using var host=await Host.Start();var owner=await host.Create();string id=owner.Snapshot.Id;
        string guestToken=new string('b',64),revokedToken=new string('c',64);
        var store=host.App.Services.GetRequiredService<CampaignStore>();
        await store.Access(id,owner.AccessToken,true,c=>
        {
            var build=FullCreationTests.Named("公开姓名");build=build with {Identity=build.Identity with {Backstory="绝不能返回的私人背景"}};
            c.PartyMembers.Add(new PartyMember{Id="peer",TokenHash=JsonFiles.Hash(guestToken),Character=BuildEvaluator.Create(build)});
            c.PartyMembers.Add(new PartyMember{Id="revoked",TokenHash=JsonFiles.Hash(revokedToken),Character=BuildEvaluator.Create(build),Revoked=true});
            return Task.FromResult(true);
        });
        string db=Path.Combine(host.Root,"campaigns",id+".sqlite");byte[] before=File.ReadAllBytes(db);
        foreach(string token in new[]{owner.AccessToken,guestToken})
        {
            host.Http.DefaultRequestHeaders.Authorization=new("Bearer",token);
            foreach(string actor in new[]{PartyEngine.HostId,"peer"})
            {
                var response=await host.Http.GetAsync($"/api/v1/campaigns/{id}/characters/{actor}/references");
                Check.Equal(System.Net.HttpStatusCode.OK,response.StatusCode);
                var json=JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
                Check.True(json.EnumerateObject().Select(p=>p.Name).Order().SequenceEqual(new[]{"actorId","characterId","featureDetails","notice","version"}));
                var value=json.Deserialize<CharacterRuleReferences>(JsonFiles.Options)!;
                Check.Equal(actor,value.ActorId);Check.Equal(owner.Snapshot.Version,value.Version);
                Check.True(!json.GetRawText().Contains("绝不能返回"));
            }
            foreach(string actor in new[]{"missing","revoked"})
                Check.Equal(System.Net.HttpStatusCode.NotFound,(await host.Http.GetAsync($"/api/v1/campaigns/{id}/characters/{actor}/references")).StatusCode);
        }
        host.Http.DefaultRequestHeaders.Authorization=new("Bearer",revokedToken);
        Check.Equal(System.Net.HttpStatusCode.Unauthorized,(await host.Http.GetAsync($"/api/v1/campaigns/{id}/characters/peer/references")).StatusCode);
        Check.True(before.SequenceEqual(File.ReadAllBytes(db)),"Rule GETs must not write the campaign database");
        var foreign=await host.Create("Foreign");host.Http.DefaultRequestHeaders.Authorization=new("Bearer",owner.AccessToken);
        Check.Equal(System.Net.HttpStatusCode.Unauthorized,(await host.Http.GetAsync($"/api/v1/campaigns/{foreign.Snapshot.Id}/characters/player/references")).StatusCode);
        var emptyResponse=await host.Http.PostAsJsonAsync("/api/v1/campaigns",new {name="Only host"});
        Check.Equal(System.Net.HttpStatusCode.Created,emptyResponse.StatusCode);
        var empty=(await emptyResponse.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        host.Http.DefaultRequestHeaders.Authorization=new("Bearer",empty.AccessToken);
        Check.Equal(System.Net.HttpStatusCode.NotFound,(await host.Http.GetAsync($"/api/v1/campaigns/{empty.Snapshot.Id}/characters/player/references")).StatusCode);
    }

    public static async Task Http()
    {
        string directory=Path.Combine(Path.GetTempPath(),"dicerealm-sheet-rules-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);
        var package=Package(Entry("class-feature:fighter:1:xphb:second-wind","feature","Second Wind","认证读取的中文规则夹具"));
        byte[] bytes=System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(package,JsonFiles.Options));string version=JsonFiles.Hash(bytes);
        JsonFiles.WriteBytes(Path.Combine(directory,version+".json"),bytes);JsonFiles.Write(Path.Combine(directory,"active.json"),new LocalRulesPointer(version));
        try
        {
            await using var host=await Host.Start(configure:b=>b.Configuration["LocalRules:Directory"]=directory);
            var owner=await host.Create();host.Http.DefaultRequestHeaders.Authorization=new("Bearer",owner.AccessToken);
            var sheet=await host.Http.GetFromJsonAsync<CharacterSheetView>("/api/v1/campaigns/"+owner.Snapshot.Id+"/character/sheet");
            Check.True(sheet!.FeatureDetails!.Any(e=>e.Text.Contains("认证读取的中文规则夹具")));
            Check.Equal(owner.Snapshot.Version,sheet.Version);
            host.Http.DefaultRequestHeaders.Authorization=new("Bearer","invalid");var denied=await host.Http.GetAsync("/api/v1/campaigns/"+owner.Snapshot.Id+"/character/sheet");
            Check.Equal(System.Net.HttpStatusCode.Unauthorized,denied.StatusCode);
            host.Http.DefaultRequestHeaders.Authorization=new("Bearer",owner.AccessToken);File.WriteAllText(Path.Combine(directory,version+".json"),"{}");
            var unavailable=await host.Http.GetFromJsonAsync<CharacterSheetView>("/api/v1/campaigns/"+owner.Snapshot.Id+"/character/sheet");
            Check.Equal(0,unavailable!.FeatureDetails!.Length);Check.True(unavailable.RuleDetailsNotice.Contains("无效"));
            Check.Equal(owner.Snapshot.Version,unavailable.Version);
            Check.True(unavailable.ItemDetails!.Any(i => i.HasWeight && i.Text == ""), "Corrupt text pack does not erase sourced numeric metadata");
        }
        finally{Directory.Delete(directory,true);}
    }
}
