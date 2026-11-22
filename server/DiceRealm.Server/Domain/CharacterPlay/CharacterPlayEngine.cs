namespace DiceRealm.Server.Domain;

// One self-service command seam: choices/permission and execution share the same projection.
// Typed exploration effects execute through NaturalActions; other commands keep their frozen contracts.
public sealed class CharacterPlayEngine(RulesEngine rules)
{
    public static string Block(Campaign c) => !GameLifecycle.CanAct(c) ? GameLifecycle.View(c).Message : c.Archived?"战役已归档。":!ContentRuntime.Ready(c)?"请先导入并启用内容。":
        CombatEngine.InCombat(c)?"现有自动遭遇仍在进行，请先结束；角色记录不会绕过其回合状态。":"";
    internal static bool Unable(Character c) => c.HitPoints<=0 || c.Exhaustion>=6 || c.Conditions.Any(x=>x is "Dead" or "Unconscious" or "Incapacitated" or "Paralyzed" or "Petrified" or "Stunned");
    public static CharacterSheetView View(Campaign c, bool includeEffects = true, string executingIntentId = "")
    {
        var ch=PlayResources.Ensure(c.ActingCharacter); var block=Block(c);
        ch = WearableEquipment.Project(c, ch);
        var checks=new List<SheetCheckOption>();
        foreach(var id in BuildCatalog.Get().Abilities.Select(BuildCatalog.AbilityName))
        {
            checks.Add(new("ability:"+id,id+" 属性检定",id,"",RulesEngine.TestModifier(ch,id,"",false),false));
            checks.Add(new("save:"+id,id+" 豁免",id,"",RulesEngine.TestModifier(ch,id,"",true),true));
        }
        foreach(var skill in BuildCatalog.Get().Skills)
        {
            string ability=BuildCatalog.AbilityName(skill.Ability);
            checks.Add(new("skill:"+skill.Id,skill.Name,ability,skill.Name,RulesEngine.TestModifier(ch,ability,skill.Name,false),false));
        }
        var equipment=ch.Inventory.Where(i=>i.Quantity>0).Select(i=>(Item:i,Data:PlayCatalog.Equipment(i.Id)))
            .Where(x=>x.Data is not null && (x.Data.WeaponCategory!=""||x.Data.Kind is "LA" or "MA" or "HA" or "S"))
            .Select(x=>
            {
                string reason=block!=""?block:Unable(ch)?"当前角色无法自行换装。":PlayCatalog.EquipmentBlock(ch,x.Data!,!x.Item.Equipped);
                bool active=PlayCatalog.ActiveWeapon(ch)?.Id==x.Item.Id;
                string activateReason=block!=""?block:Unable(ch)?"当前角色无法自行换装。":PlayCatalog.EquipmentBlock(ch,x.Data!,true);
                return new SheetEquipmentOption(x.Item.Id,x.Item.Name,x.Item.Equipped,PlayCatalog.EquipSeconds(x.Data!,!x.Item.Equipped),reason=="",reason,
                    "dnd2024 / XPHB\n"+(x.Data!.ArmorClass>0?"护甲基础值："+x.Data.ArmorClass+"\n":"")+(x.Data.Damage!=""?"武器伤害骰："+x.Data.Damage+"\n":"")+
                    "属性："+string.Join(", ",x.Data.Properties)+"\n武器可同时准备携带；当前使用武器单独选择，不自动攻击或执行物品效果。",
                    active, x.Data.WeaponCategory!=""&&x.Item.Equipped&&!active&&activateReason=="", activateReason);
            }).ToArray();
        var visibleChecks=checks.Select(o=>{string reason=block!=""?block:ch.Exhaustion>=6||!o.SavingThrow&&Unable(ch)?"当前角色无法进行此检定。":"";return o with {Available=reason=="",Reason=reason};}).ToArray();
        var view = new CharacterSheetView(c.Version,block=="",block,ch,visibleChecks,equipment,SpellOptions(ch,block),Preparation(c,ch),
            "装备与已支持的效果按规则直接结算；需要掷骰或消耗时由本人确认。未指定 DC 的检定不判断成功。其他用法请在行动中说明目标与方式，信息不足会先澄清。休整由 DM 发起。",
            block!=""?block:Unable(ch)?"当前角色无法自行使用资源或操作物品。":"", ch.Advancement is null ? null : AdvancementSheet.Preparations(c, ch),
            ch.Build is null ? null : AdvancementRestChoices.Choices(c, ch),
            Loadout: EquipmentLoadout.View(ch, block != "" ? block : Unable(ch) ? "当前角色无法自行换装。" : "", EquipmentLoadout.ActiveDrops(c)),
            Wearables: WearableEquipment.View(c, executingIntentId),
            Weight: InventoryWeight.Project(ch, c.Adventure?.Items),
            Packs: EquipmentPacks.View(c));
        return !includeEffects ? view : view with { Effects = NaturalActions.Choices(c, view)
            .Select(x => new SheetEffectOption(x.Key, x.Label, x.ItemId, x.SpellSource, NaturalActions.Details(x))).ToArray() };
    }
    public static SheetPreparation Preparation(Campaign c,Character ch)
    {
        if (ch.Advancement is not null) return AdvancementSheet.Preparations(c, ch).Single(s => s.ClassId == ch.Build!.ClassId);
        var cls=BuildCatalog.Get().Classes.FirstOrDefault(x=>x.Name==ch.ClassName);
        string[] selected=ch.PlayState!.PreparedSpells;
        bool supported=cls is not null && cls.Id is "cleric" or "druid" or "wizard" or "paladin" or "ranger";
        int max=cls?.Id is "paladin" or "ranger"?1:selected.Length;
        var book=ch.Build?.Spellbook??ch.Spellcasting?.Spells.Where(s=>s.Level==1).Select(s=>s.Id).ToArray()??[];
        var options=supported?BuildCatalog.Get().Spells.Where(s=>s.Level==1&&s.Classes.Contains(cls!.Id)&&!cls.AutomaticSpells.Contains(s.Id)
            && (cls.Id!="wizard"||book.Contains(s.Id))).Select(s=>new BuildOption(s.Id,s.Name,PlayCatalog.SpellDetails(s.Id))).ToArray():[];
        string reason=Block(c);
        if(reason=="") reason=!supported?"此职业的法术替换与升级绑定；本阶段不开放升级替换。":Unable(ch)?"当前角色无法准备法术。":
            !ch.PlayState!.PreparationOpen || (ch.PlayState.PreparedClasses ?? []).Contains("")?"完成长休后可一次性调整准备清单；其他行动会结束这个调整窗口。":"";
        return new(reason=="",reason,selected.Length,max,options,selected);
    }
    private static BuildSpellGrant[] Grants(Character ch) => (ch.BuildMechanics?.SpellGrants??[])
        .Select(g=>g.Source=="class:ranger"&&g.Id=="hunter-s-mark"?g with {FreeUses=2}:g).ToArray();
    // Source/slot authority is shared with standard combat; that engine owns action economy,
    // targets, components and actual effects rather than clearing the exploration block.
    public static SheetSpellOption[] SpellSources(Character ch) => SpellOptions(PlayResources.Ensure(ch), "");
    private static SheetSpellOption[] SpellOptions(Character ch,string block)
    {
        if (ch.Advancement is not null) return AdvancementSheet.Spells(ch, block);
        var result=new List<SheetSpellOption>(); var cls=BuildCatalog.Get().Classes.Single(x=>x.Name==ch.ClassName);
        void Add(string key,string id,string source,string ability,string resource,bool ritual=false)
        {
            var info=PlayCatalog.Spells.Single(x=>x.Id==id); string reason=block;
            int remaining=resource==""?-1:ch.Resources.FirstOrDefault(r=>r.Name==resource)?.Current??0;
            if(reason==""&&Unable(ch))reason="当前角色不能记录施法。";
            if(reason==""&&remaining==0)reason="所选来源的资源已用尽。";
            int mod=CharacterEngine.Ability(ch,BuildCatalog.AbilityName(ability));
            result.Add(new(key,id,info.Name+(ritual?" · 仪式记录":""),source,BuildCatalog.AbilityName(ability),ch.ProficiencyBonus+mod,8+ch.ProficiencyBonus+mod,
                resource,remaining,PlayCatalog.SpellDetails(id)+(ritual?"\n仪式比通常施法多十分钟；此处不自动推进时间。":""),reason=="",reason));
        }
        void Sources(string key,string id,string source,string ability,bool cantrip,bool atWill,int free=0,string freeResource="")
        {
            if(cantrip||atWill)Add(key+"/at-will",id,source,ability,"");
            else
            {
                if(free>0)Add(key+"/free",id,source,ability,freeResource);
                foreach(var r in ch.Resources.Where(r=>r.Name is "Spell Slots (1st)" or "Pact Slots (1st)"))Add(key+"/"+(r.Name.StartsWith("Pact",StringComparison.Ordinal)?"pact":"slot"),id,source,ability,r.Name);
                if(PlayCatalog.Spells.Single(s=>s.Id==id).Ritual)Add(key+"/ritual",id,source,ability,"",true);
            }
        }
        string[] cantrips=ch.Build?.Cantrips??ch.Spellcasting?.Spells.Where(s=>s.Level==0).Select(s=>s.Id).ToArray()??[];
        if(cls.SpellAbility!="")
        {
            foreach(var id in cantrips)Sources("class/"+id,id,"class:"+cls.Id,cls.SpellAbility,true,false);
            foreach(var id in ch.PlayState!.PreparedSpells)Sources("class/"+id,id,"class:"+cls.Id,cls.SpellAbility,false,false);
            if(cls.Id=="wizard")
                foreach(var id in (ch.Build?.Spellbook??[]).Except(ch.PlayState.PreparedSpells).Where(id=>PlayCatalog.Spells.Single(s=>s.Id==id).Ritual))
                    Add("book/"+id+"/ritual",id,"class:wizard / Ritual Adept",cls.SpellAbility,"",true);
        }
        var grants=Grants(ch);
        for(int i=0;i<grants.Length;i++)
        {
            var g=grants[i];Sources("grant/"+i+"/"+g.Id,g.Id,g.Source,g.Ability,PlayCatalog.Spells.Single(s=>s.Id==g.Id).Level==0,g.Mode=="at-will",g.FreeUses,PlayResources.FreeSpell(g));
        }
        return result.ToArray();
    }
    public Resolution Resolve(Campaign c,CharacterPlayRequest request, string executingIntentId = "")
    {
        if(request.Operation is null||request.Key is null||request.Key.Length>240||request.Key.Any(char.IsControl)||request.Mode is not ("normal" or "advantage" or "disadvantage")
            ||request.Choices?.Length>40||request.Choices?.Any(x=>x is null||x.Length>100)==true)
            throw new GameException("invalid_character_command","角色指令字段不合法。");
        if(request.Operation is not ("prepare" or "rest-choice")&&request.Choices is {Length:>0} || request.Operation!="check"&&request.Mode!="normal")
            throw new GameException("invalid_character_command","此指令不能携带额外选项或检定模式。");
        var view=View(c, executingIntentId: executingIntentId); if(!view.Enabled)throw new GameException("character_unavailable",view.Reason,409);
        // Public runtime modifiers/status must never be persisted into acquisition mechanics.
        var ch=PlayResources.Ensure(c.ActingCharacter); string summary; DiceCheck? check=null; string ruling=""; Resolution? executed = null;
        switch(request.Operation)
        {
            case "unpack":
                if (request.Value != 1)
                    throw new GameException("invalid_character_command", "拆开套装只接受一份，不接受额外选项。");
                var unpacked = EquipmentPacks.Apply(c, request.Key);
                ch = unpacked.Character; summary = unpacked.Summary;
                EquipmentLoadout.RequireInventory(ch);
                break;
            case "wear":
            case "attunement":
                if (request.Value != 1) throw new GameException("invalid_character_command", "穿戴与同调不能指定额外数量。");
                var wearable = WearableEquipment.Apply(c, request.Operation, request.Key, executingIntentId);
                ch = wearable.Character; summary = wearable.Summary;
                break;
            case "execute":
                executed = NaturalActions.Resolve(c, request, rules); ch = c.ActingCharacter; summary = executed.Summary;
                break;
            case "check":
                if(request.Value!=1)throw new GameException("invalid_character_command","检定不能指定数值加成。");
                var option=view.Checks.SingleOrDefault(x=>x.Id==request.Key)??throw new GameException("invalid_character_command","请选择服务端提供的检定。");
                if(ch.Exhaustion>=6||!option.SavingThrow&&Unable(ch))throw new GameException("character_unavailable","当前角色无法进行此检定。",409);
                check=rules.SheetTest(ch,option,request.Mode);
                summary=check.Mode=="automatic-failure"?$"{ch.Name} 的 {option.Label} 因已记录状态自动失败，未掷骰。":$"{ch.Name}：{option.Label}，d20 [{string.Join(", ",check.Rolls)}] {check.Modifier:+0;-0;+0} = {check.Total}。未指定 DC，结果由主持判定。";
                break;
            case "loadout":
                if (request.Value != 1) throw new GameException("invalid_character_command", "装备配置不能指定额外数量。");
                var loadout = EquipmentLoadout.Apply(ch, request.Key, Unable(ch) ? "当前角色无法自行换装。" : "", EquipmentLoadout.ActiveDrops(c));
                ch = loadout.Character; summary = loadout.Summary;
                c.ActingCharacter = ch; CharacterEngine.Advance(c, loadout.Seconds); ch = c.ActingCharacter;
                break;
            case "equip":
                if(request.Value is not (0 or 1))throw new GameException("invalid_character_command","装备值须为 0 或 1。");
                var gear=view.Equipment.SingleOrDefault(x=>x.Id==request.Key)??throw new GameException("invalid_character_command","只能操作已持有的护甲、盾或武器。");
                bool equip=request.Value==1;
                bool activate=equip&&gear.Equipped&&gear.CanActivate;
                if(!gear.Available||gear.Equipped==equip&&!activate)throw new GameException("character_unavailable",gear.Reason!=""?gear.Reason:gear.ActivateReason!=""?gear.ActivateReason:"装备状态已改变，请刷新。",409);
                var legacyLoadout = EquipmentLoadout.Legacy(ch, gear.Id, equip);
                if (equip && PlayCatalog.Equipment(gear.Id) is { } legacyGear && (legacyGear.WeaponCategory != "" || legacyGear.Kind == "S") &&
                    EquipmentLoadout.WithDropped(ch, legacyLoadout, EquipmentLoadout.ActiveDrops(c)) is { Length: > 0 } dropReason)
                    throw new GameException("loadout_unavailable", dropReason, 409);
                var beforeGear = ch;
                ch=PlayCatalog.SetEquipment(ch,gear.Id,equip);
                int gearSeconds = PlayCatalog.Equipment(gear.Id)?.Kind is "LA" or "MA" or "HA" ? gear.Seconds : EquipmentLoadout.Seconds(beforeGear, EquipmentLoadout.Read(ch));
                summary=$"{ch.Name} {(activate?"改为当前使用":equip?"准备":"收起 / 卸下")} {gear.Name}；经过 {gearSeconds} 秒。其他已准备武器保持携带，没有自动攻击或使用物品效果。";
                c.ActingCharacter=ch; CharacterEngine.Advance(c,gearSeconds); ch=c.ActingCharacter;
                break;
            case "spend":
                if(Unable(ch))throw new GameException("character_unavailable","当前角色不能自行使用能力。",409);
                var resource=ch.Resources.SingleOrDefault(r=>r.Name==request.Key)??throw new GameException("invalid_character_command","请选择已有资源。");
                if(request.Value<1||request.Value>resource.Current)throw new GameException("resource_insufficient","资源数量不足。",409);
                ch=ch with {Resources=ch.Resources.Select(r=>r.Name==resource.Name?r with {Current=r.Current-request.Value}:r).ToArray()};
                summary=$"{ch.Name} 记录消耗 {resource.Name} ×{request.Value}；余 {resource.Current-request.Value}/{resource.Maximum}。具体能力效果待裁定，未自动修改目标。";
                ruling=Pending(c,summary,"已扣除指定资源；裁定时不要再次扣除同一份消耗。拒绝使用时可通过授权调整明确退还。");
                break;
            case "use":
                if (Unable(ch)) throw new GameException("character_unavailable", "当前角色无法使用物品。", 409);
                if (request.Value != 1) throw new GameException("invalid_character_command", "一次提出一项物品使用意图，不接受手工消耗数量。 ");
                var usable = ch.Inventory.SingleOrDefault(i => i.Id == request.Key && i.Quantity > 0)
                    ?? throw new GameException("invalid_character_command", "只能使用已持有的物品。");
                summary = ch.Name + " 请求使用 " + usable.Name + "。具体用法、消耗和效果待主持裁定，尚未扣除物品。";
                ruling = Pending(c, summary, "确认物品用法与所需消耗；由后端应用裁定后的变化，不要求玩家补账。");
                break;
            case "consume":
                if(Unable(ch))throw new GameException("character_unavailable","当前角色不能自行操作物品。",409);
                var item=ch.Inventory.SingleOrDefault(i=>i.Id==request.Key)??throw new GameException("invalid_character_command","只能扣除已持有物品。");
                if(request.Value<1||request.Value>item.Quantity)throw new GameException("item_insufficient","持有数量不足。",409);
                ch=ch with {Inventory=ch.Inventory.Select(i=>i.Id==item.Id?i with {Quantity=i.Quantity-request.Value,Equipped=i.Equipped&&i.Quantity>request.Value}:i).Where(i=>i.Quantity>0).ToArray()};
                EquipmentLoadout.RequireInventory(ch);
                summary=$"{ch.Name} 从行囊扣除 {item.Name} ×{request.Value}；未自动治疗、出售、转移或生成其他物品。";
                ruling=Pending(c,summary,"物品已扣除，效果未执行；主持裁定时不要重复扣除。");
                break;
            case "spell":
                if(request.Value!=1)throw new GameException("invalid_character_command","一次记录一次施法。");
                var spell=view.Spells.SingleOrDefault(s=>s.Id==request.Key)??throw new GameException("invalid_character_command","请选择已取得且当前准备的来源法术。");
                if(!spell.Available)throw new GameException("character_unavailable",spell.Reason,409);
                if(spell.Resource!="")ch=ch with {Resources=ch.Resources.Select(r=>r.Name==spell.Resource?r with {Current=r.Current-1}:r).ToArray()};
                summary=$"{ch.Name} 记录使用 {spell.Name}（{spell.Source}）；"+(spell.Resource==""?"不消耗已记录的法术资源。":$"扣除 {spell.Resource} ×1。")+"尚未执行目标效果、材料消耗、专注或时间推进。";
                ruling=Pending(c,summary,"所选施法资源已按记录处理；组件、触发、范围、目标和效果待主持裁定，不应再次扣除同一法术位。");
                break;
            case "rest-choice":
                if (request.Value != 1) throw new GameException("invalid_character_command", "休息调整不能指定额外数量。");
                ch = AdvancementRestChoices.Apply(c, ch, request.Key, request.Choices ?? []);
                summary = ch.Name + " 在长休后更新了 " + view.RestChoices!.Single(s => s.Key == request.Key).Label + "；未改变取得历史或恢复资源。";
                break;
            case "prepare":
                if (ch.Advancement is not null)
                {
                    if (request.Value != 1) throw new GameException("invalid_character_command", "准备法术不接受额外数量。");
                    ch = AdvancementSheet.Prepare(c, ch, request.Key, request.Choices ?? []);
                    summary = ch.Name + " 在长休后更新了 " + (request.Key == "" ? ch.Build!.ClassId : request.Key) + " 的准备法术；未改写取得历史或恢复法术位。";
                    break;
                }
                if(request.Key!=""||request.Value!=1)throw new GameException("invalid_character_command","准备清单不能携带额外目标或数量。");
                var preparation=view.Preparation; var selected=request.Choices??[];
                if(!preparation.Available)throw new GameException("character_unavailable",preparation.Reason,409);
                if(selected.Length!=preparation.Count||selected.Distinct().Count()!=selected.Length||selected.Any(id=>!preparation.Options.Any(o=>o.Id==id))
                    ||selected.Except(preparation.Selected).Count()>preparation.MaxChanges)
                    throw new GameException("invalid_preparation","准备数量、法术来源或本次可替换数量不合法。");
                ch=ch with {PlayState=ch.PlayState! with {PreparedSpells=selected.ToArray(),PreparedClasses=[..ch.PlayState.PreparedClasses ?? [], ""]}};
                var all=(ch.Build?.Cantrips??ch.Spellcasting!.Spells.Where(s=>s.Level==0).Select(s=>s.Id).ToArray()).Concat(selected).Concat(ch.Build?.Spellbook??[]).Concat(Grants(ch).Select(g=>g.Id)).Distinct();
                ch=ch with {Spellcasting=ch.Spellcasting! with {Spells=all.Select(id=>
                {
                    var data=PlayCatalog.Spells.Single(s=>s.Id==id);var prior=ch.Spellcasting.Spells.FirstOrDefault(s=>s.Id==id);
                    return new SpellView(id,data.Name,data.Level,data.Level==0||selected.Contains(id)||Grants(ch).Any(g=>g.Id==id),prior?.Automated??false,data.Casting,PlayCatalog.SpellDetails(id));
                }).ToArray()}};
                summary=ch.Name+" 在长休后更新了准备法术。建卡取得记录与法术书未被改写；没有恢复或消耗法术位。";
                break;
            case "feature":
                if(request.Value!=1||!int.TryParse(request.Key,out int index)||index<0||index>=ch.Features.Length)throw new GameException("invalid_character_command","请选择已有能力。");
                summary=ch.Name+" 请求裁定能力："+ch.Features[index]+"。未扣除资源或应用效果。";
                ruling=Pending(c,summary,"需要主持确认触发、资源和效果；这是请求，不代表能力已生效。");
                break;
            default: throw new GameException("invalid_character_command","未知的角色操作。");
        }
        bool keepRest = request.Operation is "prepare" or "rest-choice"
            && (Preparation(c, ch).Available || ch.Advancement is not null && AdvancementSheet.Preparations(c, ch).Any(p => p.Available)
                || AdvancementRestChoices.Choices(c, ch).Any(p => p.Available));
        ch=ch with {PlayState=ch.PlayState! with {PreparationOpen=keepRest},ShortRestDiceAvailable=request.Operation == "attunement"};
        c.ActingCharacter=ch; c.ActingPendingAbilityCheck=null; CharacterEngine.Sync(c);
        return executed ?? new("resolved","character."+request.Operation,summary,check,["character:"+ch.Id],ruling);
    }
    private static string Pending(Campaign c,string text,string reason)
    {
        string id=Guid.NewGuid().ToString();c.PendingRulings.Add(new(id,text,"pending",reason,c.ActingActorId,c.SceneId));return id;
    }
}
