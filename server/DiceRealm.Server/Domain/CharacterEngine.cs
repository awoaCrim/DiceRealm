namespace DiceRealm.Server.Domain;

public sealed record SpellView(string Id, string Name, int Level, bool Prepared, bool Automated, string CastingTime, string Summary, string Source = "XPHB");
public sealed record Spellcasting(string Ability, int AttackBonus, int SaveDc, SpellView[] Spells);
public sealed record TimedEffect(string Id, string Name, long ExpiresAtSeconds);
public sealed record SpellRoll(string SpellId, string TargetId, int SlotLevel, int[] DamageRolls, int Damage, string DamageType, string Source = "XPHB", string Ruleset = "dnd2024");

// Two verified presets with bounded server-validated creation choices. Every selectable mutation is
// generated here from the carried inventory, class, resources and current safe area.
public sealed class CharacterEngine(IDice dice)
{
    public const string Fighter = "human-fighter-soldier-2024", Wizard = "human-wizard-soldier-2024";
    public static readonly string[] Kinds = ["character.cast", "equipment.equip", "equipment.armor", "rest.short", "rest.recover", "rest.long", "rest.wait", "rest.hit_die", "rest.arcane"];
    public static readonly string[] WeaponIds = ["greatsword", "quarterstaff", "dagger"];
    public static int Ability(Character c, string name) => RulesEngine.AbilityModifier(c.Abilities.Single(a => a.Name == name).Score);
    public static int Value(Character c, string name) => c.Resources.FirstOrDefault(r => r.Name == name)?.Current ?? 0;
    public static string HitDie(Character c) => $"Hit Dice (d{BuildRuntime.HitDie(c)})";
    public static bool Armored(Character c) => BuildRuntime.Armored(c);
    public static Item? Weapon(Character c) => PlayCatalog.ActiveWeapon(c) is { } item && WeaponIds.Contains(item.Id) ? item : null;
    public static void Change(Campaign c, string name, int delta) => c.ActingCharacter = c.ActingCharacter with
    { Resources = c.ActingCharacter.Resources.Select(r => r.Name == name ? r with { Current = Math.Clamp(r.Current + delta, 0, r.Maximum) } : r).ToArray() };
    public static void Sync(Campaign c)
    {
        foreach (var (id, original) in PartyEngine.Characters(c, includeRevoked: true).ToArray())
        {
            var ch = WearableEquipment.EndOnDeath(original);
            var effects = (ch.Effects ?? []).Where(e => e.ExpiresAtSeconds > c.ElapsedSeconds && !(e.Id == "mage-armor" && Armored(ch))).ToArray();
            var updated = ch with { Effects = effects, Concentration = ConcentrationEffects.Current(c, ch), ArmorClass = BuildRuntime.ArmorClass(ch,effects.Any(e => e.Id == "mage-armor")),
                BuildMechanics = ch.BuildMechanics is null ? null : ch.BuildMechanics with { Speed = BuildRuntime.Speed(ch),
                    CurrencyCp = (int)Math.Min(int.MaxValue,ch.Inventory.Sum(i=>(long)i.Quantity*(i.Id=="gold-piece"?100:i.Id=="silver-piece"?10:i.Id=="copper-piece"?1:0))) } }; 
            PartyEngine.SetCharacter(c, id, updated);
            // Closed combats are historical records. Only synchronize the live board.
            if (CombatEngine.InCombat(c) && PartyEngine.Unit(c, id) is { } p)
            {
                p.ArmorClass = updated.ArmorClass; p.HitPoints = updated.HitPoints; p.MaxHitPoints = updated.MaxHitPoints;
            }
        }
    }
    public static void Advance(Campaign c, long seconds)
    {
        c.ElapsedSeconds = checked(Math.Max(c.ElapsedSeconds, (long)c.ElapsedMinutes * 60) + seconds);
        c.ElapsedMinutes = checked((int)(c.ElapsedSeconds / 60));
        Sync(c);
    }
    public static int Heal(Campaign c, int amount)
    {
        int actual = Math.Min(Math.Max(0, amount), c.ActingCharacter.MaxHitPoints - c.ActingCharacter.HitPoints);
        c.ActingCharacter = c.ActingCharacter with { HitPoints = c.ActingCharacter.HitPoints + actual };
        Sync(c); return actual;
    }
    public static ActionChoice[] Choices(Campaign c)
    {
        if (CombatEngine.InCombat(c) || c.ActingCharacter.HitPoints<=0 || c.ActingCharacter.Exhaustion>=6) return [];
        bool recovery = PartyEngine.NeedsRecovery(c);
        if (recovery) return ShortRestChoices(c, true);
        if (c.ActingCharacter.Conditions.Contains("Unconscious")) return [];
        ActionChoice[] extraDice = [];
        if (c.ActingCharacter.ShortRestDiceAvailable && c.ActingCharacter.HitPoints < c.ActingCharacter.MaxHitPoints)
            extraDice = c.ActingCharacter.Advancement is not null ? AdvancementRest.DieChoices(c.ActingCharacter, false)
                : Value(c.ActingCharacter, HitDie(c.ActingCharacter)) > 0 ? [new("rest.hit_die", "", "在刚才短休中再花 1 颗生命骰")] : [];
        var choices = new List<ActionChoice>(extraDice);
        if (c.ActingCharacter.ShortRestDiceAvailable)
        {
            if (c.ActingCharacter.Advancement is not null)
                choices.AddRange(AdvancementRest.ArcaneChoices(c.ActingCharacter).Select(a => new ActionChoice("rest.arcane", a.Target, "奥术回想 · 恢复 " + a.Label)));
            else if (Value(c.ActingCharacter, "Arcane Recovery") > 0 && c.ActingCharacter.Inventory.Any(i => i.Id == "spellbook" && i.Quantity > 0)
                && c.ActingCharacter.Resources.Any(r => r.Name == "Spell Slots (1st)" && r.Current < r.Maximum))
                choices.Add(new("rest.arcane", "arcane", "奥术回想 · 恢复 1 个 1 环位"));
        }
        if (c.ActingCharacter.Conditions.Contains("Prone")) return [new("rest.recover", "", StandardCombatEngine.IsStandard(c) ? "战斗外起身（不自动拾回装备）" : "起身，拾回并准备武器"), ..choices];
        if (CanCast(c, "mage-armor")) choices.Add(new("character.cast", "mage-armor:self", "Mage Armor / 自身护甲（1 环）"));
        foreach (var item in c.ActingCharacter.Inventory.Where(i => WeaponIds.Contains(i.Id) && PlayCatalog.ActiveWeapon(c.ActingCharacter)?.Id != i.Id && i.Quantity > 0 && BuildRuntime.CanPrepareWeapon(c.ActingCharacter,i.Id) &&
            EquipmentLoadout.WithDropped(c.ActingCharacter, EquipmentLoadout.Legacy(c.ActingCharacter, i.Id, true), EquipmentLoadout.ActiveDrops(c)) == ""))
        {
            int seconds = EquipmentLoadout.Seconds(c.ActingCharacter, EquipmentLoadout.Legacy(c.ActingCharacter, item.Id, true));
            choices.Add(new("equipment.equip", item.Id, "准备 " + item.Name + (seconds > 0 ? "（" + seconds + " 秒）" : "")));
        }
        if (c.ActingCharacter.ClassName == "Fighter" && BuildRuntime.CanToggleChain(c.ActingCharacter) && c.ActingCharacter.Inventory.Any(i => i.Id == "chain-mail" && i.Quantity > 0))
            choices.Add(new("equipment.armor", Armored(c.ActingCharacter) ? "doff" : "don", Armored(c.ActingCharacter) ? "卸下 Chain Mail（5 分钟）" : "穿戴 Chain Mail（10 分钟）"));
        if (ContentRuntime.SafeRest(c))
        {
            choices.AddRange(ShortRestChoices(c, false));
            if (c.ActingCharacter.HitPoints >= 1 && c.ElapsedSeconds >= c.ActingCharacter.NextLongRestAtSeconds)
                choices.Add(new("rest.long", "", "安全区域长休 / 8 小时"));
            else if (c.ElapsedSeconds < c.ActingCharacter.NextLongRestAtSeconds)
                choices.Add(new("rest.wait", "", "在安全区域度过长休间隔（无恢复）"));
        }
        return choices.ToArray();
    }
    private static ActionChoice[] ShortRestChoices(Campaign c, bool recovery)
    {
        if (c.ActingCharacter.Advancement is not null) return AdvancementRest.ShortRestChoices(c, recovery);
        bool heal = c.ActingCharacter.HitPoints < c.ActingCharacter.MaxHitPoints && Value(c.ActingCharacter, HitDie(c.ActingCharacter)) > 0;
        bool wind = PlayResources.Ensure(c.ActingCharacter).Resources.Any(r => r.Recovery is "short" or "short-one" && r.Current < r.Maximum);
        bool arcane = Value(c.ActingCharacter, "Arcane Recovery") > 0 && c.ActingCharacter.Resources.Any(r => r.Name == "Spell Slots (1st)" && r.Current < r.Maximum);
        bool surge = c.ActingCharacter.Resources.Any(r => r.Name == "Action Surge" && r.Current < r.Maximum);
        var result = new List<ActionChoice>();
        if (wind || surge || recovery) result.Add(new("rest.short", "", "短休 1 小时 / 不花生命骰"));
        if (heal || (recovery && Value(c.ActingCharacter, HitDie(c.ActingCharacter)) > 0)) result.Add(new("rest.short", "hit_die", "短休并花 1 颗生命骰"));
        if (arcane)
        {
            result.Add(new("rest.short", "arcane", "短休 / Arcane Recovery 恢复 1 环位"));
            if (heal) result.Add(new("rest.short", "hit_die_arcane", "短休 / 生命骰与 Arcane Recovery"));
        }
        return result.ToArray();
    }
    public Resolution Resolve(Campaign c, string kind, string target)
    {
        if (!Choices(c).Any(a => a.Kind == kind && a.Target == target))
            throw new GameException("action_unavailable", "当前场景、装备或资源不允许此行动。", 409);
        c.ActingCharacter = PlayResources.Ensure(c.ActingCharacter);
        c.ActingCharacter = c.ActingCharacter with { PlayState = c.ActingCharacter.PlayState! with { PreparationOpen = false } };
        string summary;
        switch (kind)
        {
            case "character.cast":
                Change(c, "Spell Slots (1st)", -1); MageArmor(c);
                summary = "对自身施放 Mage Armor，消耗 1 个 1 环法术位；基础 AC 改为 13 + DEX，持续 8 小时，穿上护甲会提前结束。";
                break;
            case "equipment.equip":
                var beforeEquipment = c.ActingCharacter;
                c.ActingCharacter = PlayCatalog.SetEquipment(c.ActingCharacter, target, true);
                int equipmentSeconds = EquipmentLoadout.Seconds(beforeEquipment, EquipmentLoadout.Read(c.ActingCharacter));
                Advance(c, equipmentSeconds);
                summary = "战斗外准备 " + Weapon(c.ActingCharacter)!.Name + "，按装备栏近战组合持握；经过 " + equipmentSeconds + " 秒。不自动执行投掷或双持额外攻击。";
                break;
            case "equipment.armor":
                c.ActingCharacter = c.ActingCharacter with { Inventory = c.ActingCharacter.Inventory.Select(i => i.Id == "chain-mail" ? i with { Equipped = target == "don" } : i).ToArray() };
                Advance(c, target == "don" ? 600 : 300);
                summary = target == "don" ? "花费 10 分钟穿戴 Chain Mail，AC 16。" : "花费 5 分钟卸下 Chain Mail，恢复无甲 AC。";
                break;
            case "rest.short": summary = ShortRest(c, target); break;
            case "rest.hit_die": summary = "追加短休生命骰，不再经过一小时。" + SpendHitDie(c, target, false); break;
            case "rest.arcane":
                if (c.ActingCharacter.Advancement is not null) summary = AdvancementRest.Recover(c, target);
                else { Change(c, "Arcane Recovery", -1); Change(c, "Spell Slots (1st)", 1); summary = "奥术回想已恢复 1 个 1 环位。"; }
                summary += "使用刚才短休的恢复机会，未额外推进时间。";
                break;
            case "rest.recover":
                bool standard = StandardCombatEngine.IsStandard(c);
                c.ActingCharacter = c.ActingCharacter with { Conditions = c.ActingCharacter.Conditions.Where(s => s != "Prone").ToArray() };
                string dropped = PartyEngine.DroppedWeapon(c);
                bool recoverWeapon = !standard && c.ActingCharacter.Inventory.Any(i => i.Id == dropped && i.Quantity > 0 && !i.Equipped)
                    && PlayCatalog.Equipment(dropped) is { } droppedData && PlayCatalog.EquipmentBlock(c.ActingCharacter, droppedData, true) == "";
                if (recoverWeapon)
                {
                    c.ActingCharacter = PlayCatalog.SetEquipment(c.ActingCharacter, dropped, true);
                    if (PartyEngine.Unit(c) is { } unit) unit.DroppedWeaponId = "";
                    if (PartyEngine.IsHost(c) && c.Combat is not null) c.Combat.DroppedWeaponId = "";
                }
                summary = recoverWeapon ? "已在战斗外起身并拾回掉落的武器，可以继续探索。" : "已在战斗外起身；当前装备保持不变。";
                break;
            case "rest.long":
                Advance(c, 8 * 3600);
                c.ActingCharacter = PlayResources.LongRest(c.ActingCharacter) with { HitPoints = c.ActingCharacter.MaxHitPoints, NextLongRestAtSeconds = c.ElapsedSeconds + 16 * 3600 };
                summary = "在剧本指定的安全区域完成 8 小时长休；恢复全部 HP、生命骰和已记录的长休资源。" +
                    (c.ActingCharacter.Species == "Human" ? "Human Resourceful 获得 Heroic Inspiration。" : "未自动安排物种特有的休息方式或其他能力使用。") + "须间隔 16 小时才能开始下次长休。";
                break;
            default:
                var remaining = c.ActingCharacter.NextLongRestAtSeconds - c.ElapsedSeconds; Advance(c, remaining);
                summary = $"在安全区域度过 {remaining / 60} 分钟日常时光。未恢复 HP 或资源，下一次长休现在可以开始。"; break;
        }
        Sync(c);
        return new("resolved", kind, summary, null, ["character:" + c.ActingCharacter.Id]);
    }
    private string ShortRest(Campaign c, string target)
    {
        Advance(c, 3600); c.ActingCharacter = PlayResources.ShortRest(c.ActingCharacter);
        c.ActingCharacter = c.ActingCharacter with { ShortRestDiceAvailable = true };
        string text = "安全短休结束，经过 1 小时。已按来源恢复短休资源；主持自定义计数器不自动恢复。";
        if (c.ActingCharacter.ClassName == "Fighter") text += "恢复 1 次 Second Wind（不超过上限）；已解锁的 Action Surge 恢复。";
        if (target.Contains("hit_die", StringComparison.Ordinal)) text += SpendHitDie(c, target, true);
        if (target.Contains("arcane", StringComparison.Ordinal))
        {
            if (c.ActingCharacter.Advancement is not null) text += AdvancementRest.Recover(c, target);
            else
            {
                Change(c, "Arcane Recovery", -1); Change(c, "Spell Slots (1st)", 1);
                text += "Arcane Recovery 恢复 1 个 1 环位，此能力完成长休后才能再次使用。";
            }
        }
        if (PartyEngine.NeedsRecovery(c))
        {
            PartyEngine.FinishRecovery(c);
            c.ActingCharacter = c.ActingCharacter with { Conditions = c.ActingCharacter.Conditions.Where(s => s != "Unconscious").ToArray() };
            text += "Unconscious 结束；仍然 Prone，武器仍掉落，请起身并拾回装备。";
        }
        return text;
    }
    private string SpendHitDie(Campaign c, string target, bool start)
    {
        int sides = c.ActingCharacter.Advancement is null ? BuildRuntime.HitDie(c.ActingCharacter) : AdvancementRest.DieSides(c.ActingCharacter, target, start);
        int roll = Roll(sides); Change(c, "Hit Dice (d" + sides + ")", -1);
        int con = Ability(c.ActingCharacter, "constitution"), healed = Heal(c, Math.Max(1, roll + con));
        return $"花费 1 颗生命骰：d{sides} [{roll}] + CON {con}，实际恢复 {healed} HP。";
    }
    public static bool CanCast(Campaign c, string id)
    {
        var ch = c.ActingCharacter;
        var spell = ch.Spellcasting?.Spells.FirstOrDefault(s => s.Id == id && s.Automated && (s.Prepared || s.Level == 0));
        if (spell is null || ch.Conditions.Contains("Unconscious") || Armored(ch) || !EquipmentLoadout.GestureHand(ch)) return false;
        if (spell.Level > 0 && Value(ch, "Spell Slots (1st)") == 0) return false;
        // V/S and a free hand are available in the authored encounter. Only Mage Armor
        // has M: XPHB p165 lets a Wizard use an Arcane Focus OR their spellbook
        // for the spell's no-cost, unconsumed material.
        return id != "mage-armor" || (!(ch.Effects ?? []).Any(e => e.Id == id && e.ExpiresAtSeconds > c.ElapsedSeconds) &&
            ch.Inventory.Any(i => (i.Id == "quarterstaff" || i.Id == "spellbook") && i.Quantity > 0));
    }
    public static void MageArmor(Campaign c)
    {
        c.ActingCharacter = c.ActingCharacter with { Effects = [..(c.ActingCharacter.Effects ?? []).Where(e => e.Id != "mage-armor"), new("mage-armor", "Mage Armor", c.ElapsedSeconds + 8 * 3600)] };
        Sync(c);
    }
    private int Roll(int sides)
    {
        int value = dice.Roll(sides);
        if (value < 1 || value > sides) throw new InvalidOperationException("Invalid dice source.");
        return value;
    }
    // All NEW character acceptance paths use this method. Keep the legacy factory below for
    // existing-character copies and old saves; never use it as a fallback for a new request.
    public static Character CreateComplete(string name, string template, CharacterCreationChoices? creation, CharacterBuild? build)
    {
        if (build is null)
            throw new GameException("full_character_build_required", "新角色必须完成完整建卡并采用复核结果，不再接受预设或简化建卡。");
        // Fighter is the historical DTO default even when templateId was omitted. Do not
        // change that default: persisted join/resubmit fingerprints must remain replayable.
        if (creation is not null || template is not ("" or Fighter) || build.Identity?.Name?.Trim() != name.Trim())
            throw new GameException("invalid_character_build", "仅提交完整构筑；不能混用旧建卡或模板，角色名须与构筑一致。");
        return BuildEvaluator.Create(build);
    }

    public static Character Create(string name, string template, CharacterCreationChoices? creation = null, CharacterBuild? build = null)
    {
        if (build is not null)
        {
            if (creation is not null || build.Identity?.Name?.Trim() != name.Trim())
                throw new GameException("invalid_character_build", "不能同时提交两种建卡格式，角色名须与已检查的构筑一致。");
            return BuildEvaluator.Create(build);
        }
        var preset = CreatePreset(name, template);
        return creation is null ? preset : CharacterCreation.Apply(preset, creation);
    }
    private static Character CreatePreset(string name, string template)
    {
        if (template == Fighter) return StarterCharacter.Create(name);
        if (template != Wizard) throw new GameException("invalid_template", "请选择经验证的 Fighter 或 Wizard 起步模板。");
        int[] scores = [9, 13, 16, 15, 12, 10];
        string[] names = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"];
        return new(Guid.NewGuid().ToString(), name, Wizard, "Human", "Wizard", "Soldier", 1, 9, 9, 11, 2,
            names.Select((n, i) => new Ability(n, scores[i], RulesEngine.AbilityModifier(scores[i]))).ToArray(),
            ["Athletics", "Intimidation", "Arcana", "History", "Investigation"],
            [new("quarterstaff", "Arcane Focus (Quarterstaff)", 1, true), new("dagger", "Dagger", 2, false), new("robe", "Robe", 1, true),
             new("spellbook", "Spellbook", 1, false), new("scholars-pack", "Scholar's Pack", 1, false), new("gold-piece", "Gold Piece", 55, false)],
            [], ["Resourceful: Heroic Inspiration after Long Rest (reroll needs adjudication)", "Skillful: Investigation", "Versatile: Alert (+PB initiative)",
                "Savage Attacker (weapon dice only, once per turn)", "Arcane Recovery (1 slot level per Long Rest)", "Ritual Adept (recorded; ritual casting needs adjudication)",
                "Simple weapon proficiency; no armor training", "Gaming Set proficiency: Dice Set", "Languages: Common, Dwarvish, Elvish", "Size: Medium; speed: 30 ft", "Saving throw proficiencies: Intelligence, Wisdom"],
            [new("Spell Slots (1st)", 2, 2), new("Arcane Recovery", 1, 1), new("Hit Dice (d6)", 1, 1), new("Heroic Inspiration", 0, 1)], "XPHB",
            new("intelligence", 4, 12, [
                new("fire-bolt", "Fire Bolt", 0, true, true, "Action", "120 ft · ranged spell attack · 1d10 Fire; disadvantage in close combat"),
                new("mage-hand", "Mage Hand", 0, true, false, "Action", "需 DM 裁定"), new("prestidigitation", "Prestidigitation", 0, true, false, "Action", "需 DM 裁定"),
                new("magic-missile", "Magic Missile", 1, true, true, "Action", "120 ft · 3 darts · 1d4+1 Force each · no attack or save"),
                new("mage-armor", "Mage Armor", 1, true, true, "Action", "Self in this build · AC 13+DEX · 8 hours · ends on donning armor"),
                new("shield", "Shield", 1, true, false, "Reaction", "需 DM 裁定，自动敌方回合尚不插入玩家反应窗口"),
                new("sleep", "Sleep", 1, true, false, "Action", "需 DM 裁定，暂不自动结算专注与豁免"),
                new("detect-magic", "Detect Magic", 1, false, false, "Action / Ritual", "已记录在法术书 · 需 DM 裁定"),
                new("find-familiar", "Find Familiar", 1, false, false, "1 hour / Ritual", "已记录在法术书 · 需 DM 裁定与材料审核")]), []);
    }
}
