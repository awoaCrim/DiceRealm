namespace DiceRealm.Server.Domain;

// Source-verified level-one counters. Descriptions explain recording, not effect automation.
public static class PlayResources
{
    public static string FreeSpell(BuildSpellGrant grant) => "Free: " + grant.Id + " [" + grant.Source + "]";
    public static Character Ensure(Character character)
    {
        var resources = character.Resources.Select(r => r with { Recovery = r.Name switch
        {
            "Second Wind" or "Rage" => "short-one", "Action Surge" or "Pact Slots (1st)" or "Adrenaline Rush" => "short", _ => r.Recovery
        }}).ToList();
        if (character.PlayState is not null) return character with { Resources=resources.ToArray() };
        void Add(string name, int max, string recovery, string description)
        { if (!resources.Any(r => r.Name == name)) resources.Add(new(name,max,max,recovery,description)); }
        var b = character.Build; int pb = character.ProficiencyBonus;
        if (b is not null)
        {
            switch (b.ClassId)
            {
                case "barbarian": Add("Rage",2,"short-one","附赠动作进入狂暴；不穿重甲。短休恢复一次，长休全部恢复；伤害、抗性与持续时间由主持处理。"); break;
                case "bard": Add("Bardic Inspiration",Math.Max(1,CharacterEngine.Ability(character,"charisma")),"long","附赠动作给予 60 尺内能看到或听到你的其他生物一颗 d6；失败的 D20 检定可使用，持续一小时。这里只记录授予次数。"); break;
                case "paladin": Add("Lay on Hands",5*character.Level,"long","按点消耗治疗池；触碰目标的附赠动作。也可花 5 点解除 Poisoned。HP 或状态变化由主持确认。"); break;
                case "sorcerer": Add("Innate Sorcery",2,"long","附赠动作，持续一分钟；Sorcerer 法术 DC +1、法术攻击有优势。这里不自动叠加效果。"); break;
            }
            switch (b.SpeciesId)
            {
                case "aasimar": Add("Healing Hands",1,"long","Magic 动作触碰目标，以熟练加值颗 d4 治疗；这里只记录次数，治疗结果需裁定。"); break;
                case "dragonborn": Add("Breath Weapon",pb,"long","用吐息替换一次攻击；范围、DEX 豁免、祖先伤害类型与伤害由主持处理。"); break;
                case "goliath": Add("Giant Ancestry",pb,"long","使用建卡所选巨人祖先的能力；触发方式和效果依所选来源裁定。"); break;
                case "orc": Add("Adrenaline Rush",pb,"short","附赠动作 Dash 并获得熟练加值数量的临时 HP；这里只记录次数，位移与临时 HP 由主持确认。"); break;
            }
            if (character.BuildMechanics?.Feats.Contains("lucky") == true) Add("Luck Points",pb,"long","花 1 点使自己的 D20 检定具有优势，或使针对自己的攻击具有劣势；先记录消耗，再选择检定模式。");
            foreach (var grant in character.BuildMechanics?.SpellGrants ?? [])
            {
                int uses=grant.Source=="class:ranger"&&grant.Id=="hunter-s-mark"?2:grant.FreeUses;
                if (uses > 0) Add(FreeSpell(grant),uses,"long","该来源法术的不消耗法术位次数；不同来源分别记录，完成长休恢复。");
            }
        }
        var prepared = b?.PreparedSpells ?? character.Spellcasting?.Spells.Where(s => s.Prepared && s.Level > 0).Select(s=>s.Id).ToArray() ?? [];
        return character with { Resources = resources.ToArray(), PlayState = new(1,prepared.ToArray()) };
    }
    public static Character ShortRest(Character c) => Ensure(c) with
    {
        Resources = Ensure(c).Resources.Select(r => r.Recovery switch
        {
            "short" => r with { Current = r.Maximum },
            "short-one" => r with { Current = Math.Min(r.Maximum,r.Current+1) },
            _ => r
        }).ToArray()
    };
    public static Character LongRest(Character c)
    {
        c=Ensure(c);
        return c with { Resources=c.Resources.Select(r=>r.Recovery=="manual"?r:r with {Current=r.Maximum}).ToArray(),
            TemporaryHitPoints=0, Exhaustion=Math.Max(0,c.Exhaustion-1), PlayState=c.PlayState! with {PreparationOpen=true, PreparedClasses=[], RestChoicesUsed=[]} };
    }
}
