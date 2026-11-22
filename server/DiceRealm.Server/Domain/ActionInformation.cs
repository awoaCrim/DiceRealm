namespace DiceRealm.Server.Domain;

// Presentation of the existing engine's choices. This module never grants permission:
// eligibility remains the exact Adventure.Choices kind/target set used by the resolver.
// Candidates are limited to public board state, carried equipment and known abilities.
public static class ActionInformation
{
    public static ActionChoice[] Build(Campaign c, ActionChoice[] allowed)
    {
        if(c.Archived || !ContentRuntime.Ready(c) || !PartyEngine.HasCharacter(c) || !GameLifecycle.CanAct(c)) return [];
        var candidates=allowed.ToList();
        void Add(string kind,string target,string label)
        { if(!candidates.Any(a=>a.Kind==kind&&a.Target==target))candidates.Add(new(kind,target,label)); }
        var ch=c.ActingCharacter;
        if (StandardCombatEngine.IsStandard(c) && CombatEngine.InCombat(c)) return allowed;
        if(CombatEngine.InCombat(c))
        {
            var b=c.Combat!;
            for(int y=0;y<b.Height;y++)for(int x=0;x<b.Width;x++)Add("combat.move",$"{x},{y}",$"移动至 {x},{y}");
            foreach(var enemy in b.Units.Where(u=>u.Team=="enemy"&&!u.Withdrawn&&u.HitPoints>0))
            {
                Add("combat.attack",enemy.Id,(CharacterEngine.Weapon(ch)?.Name??"近战武器")+" / "+enemy.Name);
                foreach(var spell in ch.Spellcasting?.Spells.Where(s=>s.Automated&&s.Id is "fire-bolt" or "magic-missile")??[])
                    Add("combat.cast",spell.Id+":"+enemy.Id,spell.Name+" / "+enemy.Name);
            }
            if(ch.Spellcasting?.Spells.Any(s=>s.Id=="mage-armor"&&s.Automated)==true)Add("combat.cast","mage-armor:self","Mage Armor / 自身");
            Add("combat.dodge","","Dodge / 闪避");Add("combat.dash","","Dash / 疾走");Add("combat.disengage","","Disengage / 撤离");
            if(ch.Resources.Any(r=>r.Name=="Second Wind"))Add("combat.second_wind","","Second Wind / 自疗");
            if(ch.Resources.Any(r=>r.Name=="Action Surge"))Add("combat.action_surge","","Action Surge / 追加非 Magic 动作");
            Add("combat.retreat","","离开边界 / 撤退");Add("combat.end_turn","","结束回合");
        }
        else
        {
            if(ch.Spellcasting?.Spells.Any(s=>s.Id=="mage-armor"&&s.Automated)==true)Add("character.cast","mage-armor:self","Mage Armor / 自身护甲（1 环）");
            if(ContentRuntime.AvailableEncounter(c) is { } encounter && !BuildRuntime.PartyCanAutomateCombat(c)) Add("combat.start","",encounter.StartLabel);

        }
        return candidates.Select(a=>a.Details is not null ? a : a with { Details=Describe(c,a,allowed.Any(x=>x.Kind==a.Kind&&x.Target==a.Target)) }).ToArray();
    }

    // Adventure time as a player reads it: hours and minutes, seconds only where they remain.
    private static string Time(long seconds) => seconds < 60 ? seconds + " 秒" : string.Join(" ", new[] {
        seconds >= 3600 ? seconds / 3600 + " 小时" : "", seconds % 3600 >= 60 ? seconds % 3600 / 60 + " 分钟" : "",
        seconds % 60 > 0 ? seconds % 60 + " 秒" : "" }.Where(part => part != ""));
    private static ActionDetails Describe(Campaign c,ActionChoice a,bool available)
    {
        var ch=c.ActingCharacter;var b=c.Combat;var self=b?.Units.FirstOrDefault(u=>u.Id==c.ActingActorId);
        var suffix=a.Kind.EndsWith(".cast",StringComparison.Ordinal)?a.Target.Split(':').Last():a.Target;
        var unit=b?.Units.FirstOrDefault(u=>u.Id==suffix);
        string target=unit?.Name??(suffix is "self" or ""?ch.Name:a.Target);
        string cost="无额外角色资源消耗",range="当前场景",note="以提交时服务端状态为准。",reason="";
        switch(a.Kind)
        {
            case "observe": target=ContentRuntime.Scene(c)!.Title;note="观察当前场景，不进行属性检定。";break;
            case "travel":
                target=Adventure.ForScene(c,a.Target).Title;range="当前已确认的相邻路线";
                var exit=Adventure.Exits(c).First(e=>e.Target==a.Target);
                cost="冒险时间 "+Time(exit.Seconds);note="移动整个队伍。";break;
            case "combat.start":target=ContentRuntime.AvailableEncounter(c)?.Title??"当前遭遇";cost="全队分别确认后进入遭遇并掷先攻";note=ContentRuntime.AvailableEncounter(c)?.Mode==StandardCombatEngine.Mode?"标准2024致命遭遇：可能倒地、死亡；玩家反应/死亡豁免分别确认。":"先攻可能使敌人先行动；非致命遭遇规则以当前剧本为准。";break;
            case "combat.move":
                var xy=a.Target.Split(',').Select(int.Parse).ToArray();target=$"格子 ({xy[0]},{xy[1]})";
                cost=$"{CombatEngine.StepCost(b!,xy[0],xy[1])} 尺移动额度";range="一次移动至相邻格；不能穿过阻挡角或被占据的格子";
                note="离开敌人触及可能触发借机攻击；Disengage 生效时除外。";break;
            case "combat.attack":cost="1 个动作";range=Distance(self,unit)+"近战触及 5 尺；不能隔着阻挡角攻击";note="使用当前准备的武器；只支持当前自动化近战方式。";break;
            case "combat.cast":case "character.cast":
                var spell=a.Target.Split(':')[0];cost=(a.Kind=="combat.cast"?"1 个动作":"施法动作（战斗外）")+(spell=="fire-bolt"?"；不消耗法术位":"；1 个 1 环法术位");
                range=spell=="mage-armor"?"当前实现仅限自身":Distance(self,unit)+"法术射程 120 尺";
                note=spell=="fire-bolt"?"远程法术攻击；近身施放可能具有劣势。":spell=="magic-missile"?"三枚飞弹指向此目标；当前不拆分目标，无攻击或豁免检定。":"持续 8 小时；穿戴护甲后结束。";break;
            case "combat.dodge":cost="1 个动作";range="自身";note="直到自身下回合开始，可见敌人的攻击具有劣势。";break;
            case "combat.dash":cost="1 个动作";range="自身";note=$"获得 {self?.Speed??0} 尺本回合移动额度，不立即移动。";break;
            case "combat.disengage":cost="1 个动作";range="自身";note="本回合移动不触发借机攻击，不立即移动。";break;
            case "combat.second_wind":cost="1 个附赠动作 + 1 次 Second Wind";range="自身";note="由服务端掷 1d10 + 职业等级恢复 HP，不超过上限。";break;
            case "combat.action_surge":cost="1 次 Action Surge；不消耗附赠动作";range="自身";note="获得一个额外非 Magic 动作；不重置每回合专长次数。当前仅在原动作已使用后提供。";break;
            case "combat.retreat":cost="5 尺移动额度";range="必须位于棋盘边界";note="仅此角色撤退；可能触发借机攻击。其他队员继续回合。";break;
            case "combat.end_turn":cost="结束当前回合；放弃本回合未用额度";range="自身";note="轮转到下一单位，敌方回合可能立即结算。";break;
            case "equipment.equip":target=ch.Inventory.FirstOrDefault(i=>i.Id==a.Target)?.Name??a.Target;range="自身行囊；仅限战斗外";note="收起原武器并准备此武器；不自动投掷或双持。";break;
            case "equipment.armor":target="自身 Chain Mail";range="自身；仅限战斗外";cost=a.Target=="don"?"冒险时间 10 分钟":"冒险时间 5 分钟";note=a.Target=="don"?"穿上护甲，Mage Armor 会结束。":"卸下护甲。";break;
            case "rest.short":
                range="剧本指定安全区域，或非致命击倒后的恢复位置";cost="冒险时间 1 小时";
                if(a.Target.Contains("hit_die",StringComparison.Ordinal))cost+=" + 1 颗生命骰";
                if(a.Target.Contains("arcane",StringComparison.Ordinal))cost+=" + 1 次 Arcane Recovery";
                note="仅按所选方式恢复当前角色，不替其他队员休息。";
                if(ch.Advancement is not null && a.Target.Contains("arcane",StringComparison.Ordinal))
                {
                    var allocation=AdvancementRest.ArcaneChoices(ch).FirstOrDefault(x=>x.Target==(a.Target=="hit_die_arcane"?"arcane":a.Target));
                    if(allocation is not null)note+="本次选定恢复："+allocation.Label+"；不恢复契约法术位或六环以上法术位。";
                }
                break;
            case "rest.arcane":
                cost="1 次奥术回想；不再经过一小时";range="DM 发起的刚才短休";
                note="仅恢复本人已消耗的指定法术位，不恢复契约法术位或六环以上法术位。";
                if(ch.Advancement is not null && AdvancementRest.ArcaneChoices(ch).FirstOrDefault(x=>x.Target==a.Target) is { } recovered)note+="本次恢复："+recovered.Label+"。";
                break;
            case "rest.hit_die":cost="1 颗生命骰；不再经过一小时";range="刚完成的短休";note="服务端掷生命骰 + CON，恢复至少 1 HP，不超过上限。";break;
            case "rest.long":cost="冒险时间 8 小时";range="剧本指定安全区域";note="恢复当前角色的 HP、生命骰与长休资源；下一次长休受服务端间隔限制。";break;
            case "rest.wait":cost="冒险时间 "+Time(Math.Max(0,ch.NextLongRestAtSeconds-c.ElapsedSeconds));range="剧本指定安全区域";note="只度过长休间隔，不恢复 HP 或资源。";break;
            case "rest.recover":range="非致命遭遇已结束";note="起身并拾回掉落武器；不恢复 HP。";break;
            case "character.tactical_mind":cost="检定因此成功时消耗 1 次 Second Wind；仍失败不消耗";range="紧接刚才的失败检定";note="额外 1d10 仅用于刚才的有效检定机会。";break;
            case "growth.level2":cost="使用已达成的等级 2 里程碑";range="安全区域，等级 1";note="服务端计算固定 HP 和职业资源；保留现有伤势与已消耗资源。";break;
            default:
                if(ContentRuntime.FindAction(c,a.Kind,a.Target) is { } authored)
                {
                    target=string.IsNullOrWhiteSpace(authored.Target)?ContentRuntime.Scene(c)!.Title:authored.Target;
                    cost="按导入剧本结算；没有额外动作资源扣除";
                    var times=authored.Always.Where(e=>e.Op=="advance").Sum(e=>e.Amount);
                    if(times>0)cost+="；固定经过 "+Time(times);
                    string Items(ContentEffect[] effects) => string.Join("、", effects.Where(e => e.Op == "item" && e.Amount < 0)
                        .Select(e => (c.Adventure!.Items.FirstOrDefault(i => i.Id == e.Key)?.Name ?? e.Key) + " ×" + -e.Amount));
                    foreach (var (label, effects) in new[] { ("必定消耗", authored.Always), ("成功时消耗", authored.Success.Effects), ("失败时消耗", authored.Failure.Effects) })
                        if (Items(effects) is { Length: > 0 } items) cost += "；" + label + items;
                    note=authored.Check is null?"无需属性检定；由服务端应用当前剧本效果。":$"由服务端进行 {authored.Check.Skill} / {authored.Check.Ability} 检定；后果依结果和导入剧本结算。";
                }
                else { cost="服务端未提供额外消耗说明";note="仅提交此服务端指令；不从名称推测规则。"; }
                break;
        }
        if(!available)reason=Unavailable(c,a,self,unit);
        return new(target,cost,range,note,reason);
    }
    private static string Distance(CombatUnit? a,CombatUnit? b)=>a is null||b is null?"":$"当前距离 {Math.Max(Math.Abs(a.X-b.X),Math.Abs(a.Y-b.Y))*5} 尺；";
    private static string Unavailable(Campaign c,ActionChoice a,CombatUnit? self,CombatUnit? target)
    {
        var ch=c.ActingCharacter;var b=c.Combat;
        if(CombatEngine.InCombat(c))
        {
            if(self is null||self.Withdrawn)return "当前角色未参战或已撤退。";
            if(self.RecoveryRestRequired||self.HitPoints<=0)return "当前角色无法行动，需要遭遇结束后恢复。";
            if(b!.ActiveActorId!=c.ActingActorId)return "尚未轮到当前角色。";
            if(a.Kind=="combat.move")
            {
                var xy=a.Target.Split(',').Select(int.Parse).ToArray();
                if(b.Cells.Any(t=>t.X==xy[0]&&t.Y==xy[1]&&t.Terrain=="blocked"))return "目标格为阻挡地形。";
                if(b.Units.Any(u=>!u.Withdrawn&&u.HitPoints>0&&u.X==xy[0]&&u.Y==xy[1]))return "目标格已被单位占据。";
                if(!CombatEngine.Adjacent(b,self.X,self.Y,xy[0],xy[1]))return "每次只能移动到相邻格，且不能穿过阻挡角。";
                return "剩余移动额度不足。";
            }
            if(a.Kind=="combat.second_wind")
                return !self.BonusActionAvailable?"本回合附赠动作已使用。":CharacterEngine.Value(ch,"Second Wind")<=0?"Second Wind 次数已用尽。":"HP 已满，无需自疗。";
            if(a.Kind=="combat.action_surge")return self.ActionAvailable?"请先使用当前动作。":"Action Surge 次数已用尽。";
            if(a.Kind=="combat.retreat")return self.X!=0&&self.Y!=0&&self.X!=b.Width-1&&self.Y!=b.Height-1?"需要先移动至棋盘边界。":"剩余移动额度不足 5 尺。";
            if(!self.ActionAvailable && a.Kind!="combat.end_turn")return "本回合动作已使用。";
            if(a.Kind=="combat.attack")
            {
                if(CharacterEngine.Weapon(ch) is null)return "没有准备当前支持的近战武器。";
                return "目标不在合法近战触及内，或被阻挡角隔开。";
            }
            if(a.Kind=="combat.cast")
            {
                if(self.SurgeAction)return "Action Surge 提供的追加动作不能用于 Magic。";
                if(target is not null&&Math.Max(Math.Abs(self.X-target.X),Math.Abs(self.Y-target.Y))*b.CellFeet>120)return "目标超出 120 尺法术射程。";
                return SpellUnavailable(c,a.Target.Split(':')[0]);
            }
        }
        if(ch.Conditions.Contains("Unconscious") && !(a.Kind=="rest.short"&&PartyEngine.NeedsRecovery(c)))return "角色处于 Unconscious，需先按恢复顺序休整。";
        if(ch.Conditions.Contains("Prone")&&a.Kind!="rest.recover"&&!PartyEngine.NeedsRecovery(c))return "请先起身并拾回装备。";
        if(a.Kind=="combat.start" && !BuildRuntime.PartyCanAutomateCombat(c))return "队伍中有完整建卡角色的能力组合尚未支持自动战斗；请使用主持裁定，不会按固定模板代算。";
        if(a.Kind=="character.cast")return SpellUnavailable(c,a.Target.Split(':')[0]);
        if(a.Kind.StartsWith("rest.",StringComparison.Ordinal))
        {
            if(!ContentRuntime.SafeRest(c)&&!PartyEngine.NeedsRecovery(c))return "此地点不是剧本指定的安全休息区域。";
            if(a.Kind=="rest.long"&&c.ElapsedSeconds<ch.NextLongRestAtSeconds)return "长休间隔尚未结束，还需 "+Time(ch.NextLongRestAtSeconds-c.ElapsedSeconds)+"。";
            if(a.Target.Contains("hit_die",StringComparison.Ordinal))return CharacterEngine.Value(ch,CharacterEngine.HitDie(ch))<=0?"生命骰已用尽。":"HP 已满，无需花费生命骰。";
            if(a.Target.Contains("arcane",StringComparison.Ordinal))return CharacterEngine.Value(ch,"Arcane Recovery")<=0?"Arcane Recovery 次数已用尽。":"1 环法术位已满。";
            return "当前没有可通过此休息恢复的资源，或需要先完成恢复步骤。";
        }
        return "当前回合、角色状态或队伍权限不允许此行动。";
    }
    private static string SpellUnavailable(Campaign c,string id)
    {
        var ch=c.ActingCharacter;var spell=ch.Spellcasting?.Spells.FirstOrDefault(s=>s.Id==id);
        if(spell is null||!spell.Automated)return "此法术未实现自动结算。";
        if(spell.Level>0&&!spell.Prepared)return "此法术尚未准备。";
        if(CharacterEngine.Armored(ch))return "当前施法实现不支持穿戴此护甲。";
        if(spell.Level>0&&CharacterEngine.Value(ch,"Spell Slots (1st)")<=0)return "1 环法术位不足。";
        if(id=="mage-armor"&&(ch.Effects??[]).Any(e=>e.Id==id&&e.ExpiresAtSeconds>c.ElapsedSeconds))return "Mage Armor 已在生效。";
        return "当前缺少施法条件或所需法器。";
    }
}
