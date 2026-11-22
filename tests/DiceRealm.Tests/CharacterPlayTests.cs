using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class CharacterPlayTests
{
    private static Campaign Campaign(string cls="cleric",string species="elf",string background="sage")
    {var c=TestContent.Campaign("harbor");c.Character=BuildEvaluator.Create(FullCreationTests.Complete(cls,species,background));return c;}
    private static CharacterPlayRequest Cmd(string op,string key="",int value=1,string mode="normal",string[]? choices=null) => new(Guid.NewGuid().ToString(),1,op,key,value,mode,choices);
    private static AdjustCharacterRequest Adjust(Campaign c,params CharacterAdjustment[] changes) => new(Guid.NewGuid().ToString(),c.Version,"player","玩家与主持已核对结果","XPHB 2024；最终数额由本场主持确认",changes);
    public static Task ProjectionAndResources()
    {
        Check.Equal(98,PlayCatalog.Spells.Length);
        foreach(var cls in BuildCatalog.Get().Classes)
        {
            var c=Campaign(cls.Id);string before=JsonSerializer.Serialize(c);var view=CharacterPlayEngine.View(c);
            Check.Equal(before,JsonSerializer.Serialize(c));Check.Equal(30,view.Checks.Length);Check.True(view.Enabled);
            Check.True(view.Character.Resources.Any(r=>r.Name==CharacterEngine.HitDie(view.Character)));
            Check.True(view.Checks.Where(o=>o.SavingThrow).All(o=>o.Modifier==view.Character.BuildMechanics!.SavingThrows.Single(s=>s.Ability==o.Ability).Modifier));
            var once=PlayResources.Ensure(c.Character.Required());var resource=once.Resources.First();once=once with {Resources=once.Resources.Select(r=>r.Name==resource.Name?r with {Current=0}:r).ToArray()};
            Check.Equal(0,PlayResources.Ensure(once).Resources.First().Current);
        }
        foreach(var pair in new[]{("barbarian","Rage",2),("bard","Bardic Inspiration",1),("paladin","Lay on Hands",5),("sorcerer","Innate Sorcery",2)})
            Check.Equal(pair.Item3,CharacterPlayEngine.View(Campaign(pair.Item1)).Character.Resources.Single(r=>r.Name==pair.Item2).Maximum);
        var warlock=Campaign("warlock","orc");var engine=new CharacterPlayEngine(new(new SequenceDice()));
        engine.Resolve(warlock,Cmd("spend","Pact Slots (1st)"));engine.Resolve(warlock,Cmd("spend","Adrenaline Rush"));
        new CharacterEngine(new SequenceDice()).Resolve(warlock,"rest.short","");
        Check.Equal(1,CharacterEngine.Value(warlock.Character.Required(),"Pact Slots (1st)"));Check.Equal(2,CharacterEngine.Value(warlock.Character.Required(),"Adrenaline Rush"));
        var barbarian=Campaign("barbarian","goliath");engine.Resolve(barbarian,Cmd("spend","Rage",2));new CharacterEngine(new SequenceDice()).Resolve(barbarian,"rest.short","");Check.Equal(1,CharacterEngine.Value(barbarian.Character.Required(),"Rage"));
        CharacterAdjustments.Apply(barbarian,Adjust(barbarian,new CharacterAdjustment("resource.define","",5,"信物能量")));
        CharacterAdjustments.Apply(barbarian,Adjust(barbarian,new CharacterAdjustment("resource","DM: 信物能量",2),new CharacterAdjustment("temporary-hp","",4),new CharacterAdjustment("exhaustion","",2)));
        new CharacterEngine(new SequenceDice()).Resolve(barbarian,"rest.long","");
        Check.Equal(2,CharacterEngine.Value(barbarian.Character,"DM: 信物能量"));Check.Equal(2,CharacterEngine.Value(barbarian.Character,"Rage"));Check.Equal(0,barbarian.Character.TemporaryHitPoints);Check.Equal(1,barbarian.Character.Exhaustion);
        return Task.CompletedTask;
    }
    public static Task EquipmentAndPreparation()
    {
        var c=Campaign("fighter","dwarf","soldier");var engine=new CharacterPlayEngine(new(new SequenceDice()));
        CharacterAdjustments.Apply(c,Adjust(c,new CharacterAdjustment("inventory","plate-armor",1),new CharacterAdjustment("inventory","shield",1),new CharacterAdjustment("inventory","longbow",1)));
        string build=JsonSerializer.Serialize(c.Character.Required().Build);
        engine.Resolve(c,Cmd("equip","plate-armor"));Check.Equal(18,c.Character.ArmorClass);Check.Equal(600L,c.ElapsedSeconds);
        engine.Resolve(c,Cmd("equip","shield"));Check.Equal(20,c.Character.ArmorClass);
        engine.Resolve(c,Cmd("equip","longbow")); Check.Equal(18,c.Character.ArmorClass); Check.Equal(612L,c.ElapsedSeconds);
        engine.Resolve(c,Cmd("equip","shield",0));
        Check.Equal(1,c.Character.Inventory.Count(i=>i.Equipped&&PlayCatalog.Equipment(i.Id)?.WeaponCategory is {Length:>0}));
        Check.Equal(build,JsonSerializer.Serialize(c.Character.Build));Check.True(!BuildRuntime.CanAutomateCombat(c.Character));
        engine.Resolve(c,Cmd("consume","plate-armor"));Check.Equal(12,c.Character.ArmorClass);Check.True(!c.Character.Inventory.Any(i=>i.Id=="plate-armor"));
        var wizard=Campaign("wizard");CharacterAdjustments.Apply(wizard,Adjust(wizard,new CharacterAdjustment("inventory","leather-armor",1)));
        Check.Throws<GameException>(()=>engine.Resolve(wizard,Cmd("equip","leather-armor")));
        Check.Throws<GameException>(()=>engine.Resolve(wizard,Cmd("prepare",choices:wizard.Character.Required().Build!.PreparedSpells)));
        new CharacterEngine(new SequenceDice()).Resolve(wizard,"rest.long","");var prep=CharacterPlayEngine.View(wizard).Preparation;Check.True(prep.Available);Check.Equal(4,prep.Count);
        var original=JsonSerializer.Serialize(wizard.Character.Required().Build);var selected=prep.Options.TakeLast(4).Select(o=>o.Id).ToArray();
        engine.Resolve(wizard,Cmd("prepare",choices:selected));Check.True(selected.SequenceEqual(wizard.Character.PlayState!.PreparedSpells));Check.Equal(original,JsonSerializer.Serialize(wizard.Character.Build));
        Check.True(!CharacterPlayEngine.View(wizard).Preparation.Available);
        Check.Throws<GameException>(()=>engine.Resolve(wizard,Cmd("prepare",choices:selected)));
        var paladin=Campaign("paladin");new CharacterEngine(new SequenceDice()).Resolve(paladin,"rest.long","");var pp=CharacterPlayEngine.View(paladin).Preparation;
        Check.Equal(1,pp.MaxChanges);Check.Throws<GameException>(()=>engine.Resolve(paladin,Cmd("prepare",choices:pp.Options.Where(o=>!pp.Selected.Contains(o.Id)).Take(2).Select(o=>o.Id).ToArray())));
        var bard=Campaign("bard");new CharacterEngine(new SequenceDice()).Resolve(bard,"rest.long","");Check.True(!CharacterPlayEngine.View(bard).Preparation.Available);
        var ranger=Campaign("ranger");var spell=CharacterPlayEngine.View(ranger).Spells.Single(s=>s.SpellId=="hunter-s-mark"&&s.Id.EndsWith("/free"));
        Check.Equal(2,spell.Remaining);var result=engine.Resolve(ranger,Cmd("spell",spell.Id));Check.Equal(1,CharacterEngine.Value(ranger.Character.Required(),spell.Resource));Check.True(result.RulingId!="");Check.Equal(1,ranger.PendingRulings.Count);
        Check.True(ranger.Character.Effects?.Length==0);Check.True(!ranger.PendingRulings[0].Reason.Contains("未消耗资源"));
        return Task.CompletedTask;
    }
    public static Task ChecksAndAdjustments()
    {
        var dice=new SequenceDice(3,18,14,11);var engine=new CharacterPlayEngine(new(dice));var c=Campaign("rogue","elf","sage");
        var view=CharacterPlayEngine.View(c);var key=view.Checks.Single(o=>o.Skill=="Arcana");var roll=engine.Resolve(c,Cmd("check",key.Id,mode:"advantage"));
        Check.Equal(18,roll.Check!.Selected);Check.True(!roll.Check.HasDc);Check.Equal(key.Modifier,roll.Check.Modifier);Check.Equal(2,dice.Count);
        Check.Throws<GameException>(()=>engine.Resolve(c,Cmd("check",key.Id,999)));Check.Equal(2,dice.Count);
        var pending=new PendingRuling("pending","治疗与补给","pending","未支持","player","harbor");c.PendingRulings.Add(pending);
        var request=Adjust(c,new CharacterAdjustment("hp","",2),new CharacterAdjustment("temporary-hp","",5),new CharacterAdjustment("condition","Poisoned",1),new CharacterAdjustment("inventory","dagger",3)) with {RulingId=pending.Id};
        var before=JsonSerializer.Serialize(c);var preview=CharacterAdjustments.Preview(c,request);Check.Equal(before,JsonSerializer.Serialize(c));Check.True(preview.Changes.Length>=3);
        CharacterAdjustments.Apply(c,request);Check.Equal(2,c.Character.Required().HitPoints);Check.Equal(5,c.Character.Required().TemporaryHitPoints);Check.True(c.Character.Required().Conditions.Contains("Poisoned"));
        Check.Equal(request.RequestId,c.PendingRulings.Single().EffectsRequestId);Check.True(c.PendingRulings.Single().Effects!.Length>=3);
        Check.Throws<GameException>(()=>CharacterAdjustments.Apply(c,request));
        CharacterAdjustments.Apply(c,Adjust(c,new CharacterAdjustment("damage","",6)));Check.Equal(1,c.Character.HitPoints);Check.Equal(0,c.Character.TemporaryHitPoints);
        CharacterAdjustments.Apply(c,Adjust(c,new CharacterAdjustment("heal","",999)));Check.Equal(c.Character.MaxHitPoints,c.Character.HitPoints);Check.True(c.Character.Conditions.Contains("Poisoned"));
        var bad=Adjust(c,new CharacterAdjustment("hp","",1),new CharacterAdjustment("level","",20));before=JsonSerializer.Serialize(c);Check.Throws<GameException>(()=>CharacterAdjustments.Apply(c,bad));Check.Equal(before,JsonSerializer.Serialize(c));
        c.PartyMembers.Add(new(){Id="guest",TokenHash="g",Character=StarterCharacter.Create("Guest")});c.ActingActorId="guest";
        Check.Throws<GameException>(()=>CharacterAdjustments.Preview(c,Adjust(c,new CharacterAdjustment("hp","",1))));c.ActingActorId="player";
        CharacterAdjustments.Apply(c,Adjust(c,new CharacterAdjustment("exhaustion","",2),new CharacterAdjustment("condition","Unconscious",1)));
        var save=engine.Resolve(c,Cmd("check","save:dexterity"));Check.Equal("automatic-failure",save.Check!.Mode);Check.Equal(2,dice.Count);
        Check.Throws<GameException>(()=>engine.Resolve(c,Cmd("check","skill:arcana")));
        CharacterAdjustments.Apply(c,Adjust(c,new CharacterAdjustment("condition","Unconscious",0)));
        roll=engine.Resolve(c,Cmd("check","skill:arcana"));Check.Equal("disadvantage",roll.Check!.Mode);Check.Equal(key.Modifier-4,roll.Check.Modifier);
        return Task.CompletedTask;
    }
    public static async Task HttpAndDurability()
    {
        var dice=new SequenceDice(17);var h=await Host.Start(dice:dice,broken:new BrokenText());var owner=await h.Create();var id=owner.Snapshot.Id;
        string path=$"/api/v1/campaigns/{id}";
        var invite=new InviteRequest(Guid.NewGuid().ToString(),1,new string('a',64));await h.Http.PostAsJsonAsync(path+"/invitations",invite);
        var build=FullCreationTests.Complete("cleric","elf","sage");var joined=await h.Http.PostAsJsonAsync(path+"/join",new JoinCampaignRequest(Guid.NewGuid().ToString(),invite.InviteToken,new string('b',64),build.Identity.Name,Build:build));
        Check.Equal(HttpStatusCode.OK,joined.StatusCode);var guest=await h.ApproveGuest(owner,(await joined.Content.ReadFromJsonAsync<CreatedCampaign>())!);h.Http.DefaultRequestHeaders.Authorization=new("Bearer",guest.AccessToken);
        var s=guest.Snapshot;var sheet=(await h.Http.GetFromJsonAsync<CharacterSheetView>(path+"/character/sheet"))!;Check.Equal(s.Character.Required().Id,sheet.Character.Required().Id);
        var req=Cmd("check","save:wisdom") with {ExpectedVersion=s.Version};
        var responses=await Task.WhenAll(h.Http.PostAsJsonAsync(path+"/character/commands",req),h.Http.PostAsJsonAsync(path+"/character/commands",req));
        foreach(var response in responses)Check.Equal(HttpStatusCode.OK,response.StatusCode);Check.Equal(1,dice.Count);
        var done=(await responses[0].Content.ReadFromJsonAsync<ActionResponse>())!;Check.True(!done.Resolution.Check!.HasDc);
        Check.Equal(owner.Snapshot.Character.Required().HitPoints,done.Snapshot.Party!.Members.Single(m=>m.Id=="player").Character.Required().HitPoints);
        var adjustment=new AdjustCharacterRequest(Guid.NewGuid().ToString(),done.Snapshot.Version,guest.Snapshot.Party!.SelfActorId,"治疗已确认","本场主持",[new CharacterAdjustment("hp","",1),new CharacterAdjustment("resource","Spell Slots (1st)",0)]);
        Check.Equal(HttpStatusCode.Forbidden,(await h.Http.PostAsJsonAsync(path+"/characters/adjust-preview",adjustment)).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden,(await h.Http.PostAsJsonAsync(path+"/characters/adjust",adjustment)).StatusCode);
        h.Http.DefaultRequestHeaders.Authorization=new("Bearer",owner.AccessToken);
        var preview=await h.Http.PostAsJsonAsync(path+"/characters/adjust-preview",adjustment);Check.Equal(HttpStatusCode.OK,preview.StatusCode);Check.Equal(done.Snapshot.Version,(await h.Get(id))!.Version);
        var forged=new StringContent(JsonSerializer.Serialize(new{requestId=Guid.NewGuid(),expectedVersion=done.Snapshot.Version,actorId=guest.Snapshot.Party.SelfActorId,rationale="test",ruleSource="test",changes=new[]{new{operation="hp",key="",value=1}},maxHitPoints=999}),Encoding.UTF8,"application/json");
        Check.Equal(HttpStatusCode.BadRequest,(await h.Http.PostAsync(path+"/characters/adjust",forged)).StatusCode);
        var adjustResults=await Task.WhenAll(h.Http.PostAsJsonAsync(path+"/characters/adjust",adjustment),h.Http.PostAsJsonAsync(path+"/characters/adjust",adjustment));
        foreach(var response in adjustResults)Check.Equal(HttpStatusCode.OK,response.StatusCode);
        var after=(await adjustResults[0].Content.ReadFromJsonAsync<ActionResponse>())!;Check.Equal(done.Snapshot.Version+1,after.Snapshot.Version);
        Check.Equal(1,after.Snapshot.Party!.Members.Single(m=>m.Id==guest.Snapshot.Party.SelfActorId).Character.HitPoints);
        Check.Equal(HttpStatusCode.Conflict,(await h.Http.PostAsJsonAsync(path+"/characters/adjust",adjustment with {Rationale="changed"})).StatusCode);
        var root=h.Root;await h.DisposeAsync();await using var restart=await Host.Start(root,dice,broken:new BrokenText());
        restart.Http.DefaultRequestHeaders.Authorization=new("Bearer",guest.AccessToken);
        var replay=await restart.Http.PostAsJsonAsync(path+"/character/commands",req);Check.True((await replay.Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);Check.Equal(1,dice.Count);
        var resumed=await restart.Get(id);Check.Equal(1,resumed!.Character.Required().HitPoints);Check.Equal(0,CharacterEngine.Value(resumed.Character.Required(),"Spell Slots (1st)"));
        restart.Http.DefaultRequestHeaders.Authorization=new("Bearer",owner.AccessToken);replay=await restart.Http.PostAsJsonAsync(path+"/characters/adjust",adjustment);
        Check.True((await replay.Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);Check.Equal(after.Snapshot.Version,(await restart.Get(id))!.Version);
        var nulls=new StringContent(JsonSerializer.Serialize(adjustment with {RequestId=Guid.NewGuid().ToString(),ExpectedVersion=after.Snapshot.Version,Changes=[null!]}),Encoding.UTF8,"application/json");
        Check.Equal(HttpStatusCode.BadRequest,(await restart.Http.PostAsync(path+"/characters/adjust",nulls)).StatusCode);
    }
}
