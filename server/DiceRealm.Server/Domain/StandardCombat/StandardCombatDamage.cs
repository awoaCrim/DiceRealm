namespace DiceRealm.Server.Domain;

public sealed partial class StandardCombatEngine
{
    private sealed record WeaponProfile(string Id, string Name, int Dice, int Die, string DamageType, bool Finesse = false, bool TwoHands = false);
    private static readonly WeaponProfile[] Weapons =
    [
        new("club", "Club", 1, 4, "Bludgeoning"), new("greatsword", "Greatsword", 2, 6, "Slashing", TwoHands: true), new("quarterstaff", "Quarterstaff", 1, 6, "Bludgeoning"),
        new("dagger", "Dagger", 1, 4, "Piercing", true), new("mace", "Mace", 1, 6, "Bludgeoning"),
        new("longsword", "Longsword", 1, 8, "Slashing"), new("warhammer", "Warhammer", 1, 8, "Bludgeoning"),
        new("flail", "Flail", 1, 8, "Bludgeoning"), new("rapier", "Rapier", 1, 8, "Piercing", true),
        new("shortsword", "Shortsword", 1, 6, "Piercing", true), new("greataxe", "Greataxe", 1, 12, "Slashing", TwoHands: true),
        new("maul", "Maul", 2, 6, "Bludgeoning", TwoHands: true)
    ];
    private static WeaponProfile? Weapon(Campaign c, CombatUnit u)
    {
        if (Enemy(u)) return null;
        var ch = PartyEngine.CharacterFor(c, u.Id);
        var selected = PlayCatalog.ActiveWeapon(ch);
        if (selected is null) return null;
        var profile = Weapons.SingleOrDefault(w => w.Id == selected.Id);
        if (profile is null) return null;
        bool shield = EquipmentLoadout.Shield(ch);
        if (profile.TwoHands && shield) return null;
        var damage = EquipmentLoadout.Damage(ch, PlayCatalog.Equipment(profile.Id)!).Split('d');
        return profile with { Dice = int.Parse(damage[0]), Die = int.Parse(damage[1]), TwoHands = EquipmentLoadout.TwoHands(EquipmentLoadout.Read(ch), EquipmentLoadout.Read(ch).ActiveSet) };
    }
    private static bool CanMelee(Campaign c, CombatUnit a, CombatUnit z) => Able(a) && !z.Withdrawn && !Body(z).Dead &&
        CombatGeometry.Reach(Board(c), a, z) && (Enemy(a) || Weapon(c, a) is not null);
    private static bool ShortbowPosition(CombatState b, CombatUnit a, CombatUnit z) => !Enemy(z) && Able(z) &&
        CombatGeometry.Distance(a, z) <= 320 && CombatGeometry.Cover(b, a, z) != 99;
    private static bool CanShortbow(Campaign c, CombatUnit a, CombatUnit z) => Enemy(a) && Able(a) &&
        BoardCombat.EnemyProfile(c, a) is { Tactic: "ranged" } npc && StandardMonsters.IsGoblinWarrior(npc) && ShortbowPosition(Board(c), a, z);
    private static bool RangedThreatened(Campaign c, CombatUnit a) => Board(c).Units.Any(z => z.Team != a.Team && Able(z) &&
        CombatGeometry.Distance(a, z) <= 5 && Sees(c, z, a));
    private static int AttackCount(Character ch)
    {
        int fighter = NaturalActions.ClassLevel(ch, "fighter");
        if (fighter >= 20) return 4;
        if (fighter >= 11) return 3;
        return new[] { "fighter", "barbarian", "paladin", "ranger", "monk" }.Any(id => NaturalActions.ClassLevel(ch, id) >= 5) ? 2 : 1;
    }
    private static bool Feat(Character ch, string id) => ch.BuildMechanics?.Feats.Contains(id) ??
        (id == "savage-attacker" || ch.TemplateId == CharacterEngine.Fighter && id == "great-weapon-fighting");
    private static bool Mastery(Character ch, string id) => ch.BuildMechanics?.Masteries.Contains(id) ?? (ch.TemplateId == CharacterEngine.Fighter && id == "greatsword");
    private static bool WeaponProficient(Character ch, string id)
    {
        var equipment = PlayCatalog.Equipment(id)!;
        var training = ch.BuildMechanics?.WeaponTraining ?? BuildCatalog.Get().Classes.Single(x => x.Name == ch.ClassName).Weapons;
        return training.Contains(equipment.WeaponCategory) || training.Contains(id);
    }
    private void Attack(Campaign c, CombatUnit attacker, CombatUnit defender, bool opportunity, bool useMastery = false, bool ranged = false)
    {
        var b = Board(c); var profile = Weapon(c, attacker);
        var npc = Enemy(attacker) ? BoardCombat.EnemyProfile(c, attacker) : null;
        bool goblin = npc is not null && StandardMonsters.IsGoblinWarrior(npc);
        int distance = CombatGeometry.Distance(attacker, defender);
        var ch = Enemy(attacker) ? null : PartyEngine.CharacterFor(c, attacker.Id);
        int ability = ch is null ? 0 : profile!.Finesse ? Math.Max(CharacterEngine.Ability(ch, "strength"), CharacterEngine.Ability(ch, "dexterity")) : CharacterEngine.Ability(ch, "strength");
        int modifier = npc?.AttackBonus ?? ability + (WeaponProficient(ch!, profile!.Id) ? ch!.ProficiencyBonus : 0) - 2 * ch!.Exhaustion;
        int damageModifier = npc?.DamageBonus ?? ability;
        bool advantage = Body(defender).Conditions.Any(s => s is "Unconscious" or "Paralyzed" or "Stunned" or "Blinded" ||
            s == "Prone" && (!goblin || distance <= 5)) || !Sees(c, defender, attacker) || HasMasteryEffect(defender, "vex", attacker.Id);
        bool disadvantage = HasMasteryEffect(attacker, "sap") || Body(attacker).Conditions.Any(s => s is "Blinded" or "Poisoned" or "Prone") ||
            defender.Dodging && Able(defender) && Speed(c, defender) > 0 && Sees(c, defender, attacker) ||
            ch is not null && PlayCatalog.Equipment(profile!.Id)?.Properties.Contains("H") == true && ch.Abilities.Single(a => a.Name == "strength").Score < 13 ||
            goblin && (!Sees(c, attacker, defender) || distance > 5 && Body(defender).Conditions.Contains("Prone") ||
                ranged && (distance > 80 || RangedThreatened(c, attacker)));
        ConsumeAttackMasteries(attacker, defender);
        string mode = advantage == disadvantage ? "normal" : advantage ? "advantage" : "disadvantage";
        int[] rolls = mode == "normal" ? [Roll(20)] : [Roll(20), Roll(20)];
        int selected = mode == "advantage" ? rolls.Max() : mode == "disadvantage" ? rolls.Min() : rolls[0];
        // XPHB Hide ends on making the attack roll, before a Shield/damage wait.
        if (attacker.BoardEntityId is { } entityId) EncounterConcealment.Reveal(c, entityId);
        int ward = !Enemy(defender) && ConcentrationEffects.Has(c, PartyEngine.CharacterFor(c, defender.Id), "blade-ward") ? Roll(4) : 0;
        modifier -= ward;
        int armor = defender.ArmorClass + CombatGeometry.Cover(b, attacker, defender) + (Body(defender).ShieldActive ? 5 : 0);
        bool hit = selected == 20 || selected != 1 && selected + modifier >= armor;
        bool critical = hit && (selected == 20 || (!goblin || distance <= 5) && Body(defender).Conditions.Any(s => s is "Unconscious" or "Paralyzed"));
        bool graze = !hit && ch is not null && profile!.Id == "greatsword" && Mastery(ch, profile.Id);
        int count = (npc?.DamageDice ?? profile!.Dice) * (critical ? 2 : 1), sides = npc?.DamageDie ?? profile!.Die;
        bool savage = hit && ch is not null && Feat(ch, "savage-attacker") && !attacker.SavageAttackerUsed;
        bool style = hit && ch is not null && profile!.TwoHands && Feat(ch, "great-weapon-fighting");
        var roll = new AttackRoll(rolls, selected, modifier, selected + modifier, armor, mode, hit, critical, [], [], [], damageModifier, 0, graze);
        var strike = new StandardStrike(roll, count, sides, ranged ? "Piercing" : profile?.DamageType ?? StandardMonsters.Find(npc!.RulesId)?.Damage ?? "Bludgeoning",
            opportunity, savage, style, graze ? Math.Max(0, ability) : 0, useMastery, ability,
            goblin ? ranged ? "shortbow" : "scimitar" : null, goblin && mode == "advantage" ? critical ? 2 : 1 : null);
        c.StandardCombatFlow!.Steps.Insert(0, new() { Kind = "hit", ActorId = attacker.Id, TargetId = defender.Id, Strike = strike });
        if (ward > 0) Add(c, "blade_ward", defender.Id, $"Blade Ward：此次攻击掷骰减 d4 [{ward}]，已计入攻击修正。", target: attacker.Id,
            displayText: defender.Name + "的剑刃防护干扰了来袭的攻击。");
        if (hit && !Enemy(defender) && !Body(defender).ShieldActive && CastOptions(c, defender, true).Length > 0)
        {
            b.Standard!.Wait = new("shield", defender.Id, attacker.Id, $"{attacker.Name}的攻击已命中（总值{roll.Total}，自然骰{roll.Selected}）；尚未投掷伤害。可用Shield反应或明确放弃。");
            Add(c, "reaction_wait", defender.Id, b.Standard.Wait.Description, target: attacker.Id,
                displayText: attacker.Name + "的攻击即将命中" + defender.Name + "，等待护盾反应。");
        }
    }
    private void ResolveStrike(Campaign c, StandardCombatStep step)
    {
        var b = Board(c); var attacker = Unit(c, step.ActorId); var defender = Unit(c, step.TargetId); var strike = step.Strike!;
        var attack = strike.Roll;
        int armor = defender.ArmorClass + CombatGeometry.Cover(b, attacker, defender) + (Body(defender).ShieldActive ? 5 : 0);
        bool hit = attack.Selected == 20 || attack.Selected != 1 && attack.Total >= armor;
        bool critical = hit && attack.Critical;
        bool savage = hit && strike.Savage;
        int[] Set() => Enumerable.Range(0, strike.Dice).Select(_ => Roll(strike.Die))
            .Concat(Enumerable.Range(0, strike.AdvantageDamageDice ?? 0).Select(_ => Roll(4))).ToArray();
        int[] Effective(int[] values) => strike.GreatWeaponFighting ? values.Select(v => Math.Max(3, v)).ToArray() : values;
        int[] raw = hit ? Set() : [], alternate = savage ? Set() : [];
        int[] effective = Effective(alternate).Sum() > Effective(raw).Sum() ? Effective(alternate) : Effective(raw);
        // Shield can turn a formerly hitting Greatsword into a Graze miss as well.
        var ch = Enemy(attacker) ? null : PartyEngine.CharacterFor(c, attacker.Id);
        var weapon = Weapon(c, attacker);
        bool graze = !hit && ch is not null && weapon?.Id == "greatsword" && Mastery(ch, weapon.Id);
        int damage = hit ? Math.Max(0, effective.Sum() + attack.DamageModifier) : graze ? Math.Max(0, CharacterEngine.Ability(ch!, "strength")) : 0;
        if (savage) attacker.SavageAttackerUsed = true;
        var result = attack with { ArmorClass = armor, Hit = hit, Critical = critical, DamageRolls = raw, AlternateRolls = alternate, EffectiveDice = effective, Damage = damage, Graze = graze };
        string weaponName = strike.WeaponId switch { "shortbow" => " Shortbow", "scimitar" => " Scimitar", _ => "" };
        string display = strike.WeaponId == "shortbow" ? attacker.Name + "向" + defender.Name + "射箭" :
            attacker.Name + (strike.Opportunity ? "借机攻击" : "攻击") + defender.Name;
        display += hit ? critical ? "，重击命中。" : "，命中。" : graze && damage > 0 ? "，未命中，但擦中了目标。" : "，落空。";
        Add(c, strike.Opportunity ? "opportunity_attack" : "attack", attacker.Id,
            $"{attacker.Name}{weaponName}{(strike.Opportunity ? "借机攻击" : "攻击")}{defender.Name}：d20 [{string.Join(",", attack.Rolls)}] {attack.Mode} {attack.Modifier:+0;-0;0} = {result.Total} vs AC {armor}；" +
            (hit ? $"{(critical ? "重击" : "命中")}，伤害骰[{string.Join(",", raw)}]" + (strike.AdvantageDamageDice is { } extra ? $"（含优势附加{extra}d4）" : "") +
                (savage ? $" / Savage Attacker [{string.Join(",", alternate)}]" : "") + $"，有效骰[{string.Join(",", effective)}] {attack.DamageModifier:+0;-0;0} = {damage} {strike.DamageType}。"
                : graze ? $"未命中，Graze {damage} {strike.DamageType}（无伤害掷骰）。" : "未命中。"), result, target: defender.Id, displayText: display);
        int dealt = Damage(c, defender, damage, strike.DamageType, critical);
        ApplyMastery(c, attacker, defender, strike, hit, dealt);
    }
    private static void SyncCharacter(Campaign c, CombatUnit u)
    {
        if (Enemy(u)) return;
        var ch = PartyEngine.CharacterFor(c, u.Id);
        PartyEngine.SetCharacter(c, u.Id, ch with { HitPoints = u.HitPoints, TemporaryHitPoints = Body(u).TemporaryHitPoints, Conditions = Body(u).Conditions.ToArray() });
    }
    private static void RemoveCondition(Campaign c, CombatUnit u, string condition)
    {
        Body(u).Conditions = Body(u).Conditions.Where(s => s != condition).ToArray(); SyncCharacter(c, u);
    }
    private static void Die(Campaign c, CombatUnit u)
    {
        u.HitPoints = 0; Body(u).Dead = true; Body(u).Stable = false;
        Body(u).Conditions = Body(u).Conditions.Concat(["Dead", "Unconscious", "Prone"]).Distinct().ToArray();
        SyncCharacter(c, u);
        if (!Enemy(u))
        {
            PartyEngine.SetCharacter(c, u.Id, WearableEquipment.EndOnDeath(PartyEngine.CharacterFor(c, u.Id)));
            CharacterEngine.Sync(c);
        }
        Add(c, "death", u.Id, u.Name + "死亡；治疗与休息不会自动复活。", displayText: u.Name + "死亡。");
    }
    private static void Fall(Campaign c, CombatUnit u)
    {
        Body(u).ZeroHitPointUnconscious = true;
        Body(u).Conditions = Body(u).Conditions.Concat(["Unconscious", "Prone"]).Distinct().ToArray();
        u.Dodging = false;
        if (!Enemy(u))
        {
            var ch = PartyEngine.CharacterFor(c, u.Id);
            var held = EquipmentLoadout.Held(ch);
            Body(u).DroppedItems = Body(u).DroppedItems.Concat(held.Select(h => new StandardDroppedItem(h.Item.Id, u.X, u.Y, ch.PlayState?.Loadout is null ? null : h.Slot))).ToArray();
            var loadout = EquipmentLoadout.Read(ch);
            foreach (var hand in held) loadout = EquipmentLoadout.Set(loadout, hand.Slot, "");
            ch = EquipmentLoadout.Commit(ch, loadout);
            PartyEngine.SetCharacter(c, u.Id, ch);
        }
        SyncCharacter(c, u);
        CharacterEngine.Sync(c);
        Add(c, "unconscious", u.Id, u.Name + "降至0HP，昏迷并倒地，掉落已持握武器/盾；尚未掷死亡豁免。", displayText: u.Name + "倒地昏迷。");
    }
    private int Damage(Campaign c, CombatUnit u, int amount, string type, bool critical = false, bool concentrationCheck = true)
    {
        if (amount <= 0 || Body(u).Dead) return 0;
        string? monster = Enemy(u) ? BoardCombat.EnemyProfile(c, u).RulesId : null;
        if (monster is "xmm:zombie" or "xmm:skeleton")
        {
            if (type == "Poison") { Add(c, "immunity", u.Id, u.Name + "对Poison伤害免疫（XMM）。", displayText: u.Name + "免疫了这次毒素伤害。"); return 0; }
            if (monster == "xmm:skeleton" && type == "Bludgeoning") amount *= 2;
        }
        if (!Enemy(u) && (PartyEngine.CharacterFor(c, u.Id).BuildMechanics?.Resistances.Any(r => r.Equals(type, StringComparison.OrdinalIgnoreCase)) ?? false)) amount /= 2;
        if (amount <= 0)
        {
            Add(c, "damage", u.Id, u.Name + "减免后承受0点伤害。", displayText: u.Name + "抵消了这次伤害。");
            return 0;
        }
        var state = Body(u);
        int absorbed = Math.Min(amount, state.TemporaryHitPoints);
        state.TemporaryHitPoints -= absorbed;
        int remaining = amount - absorbed;
        int old = u.HitPoints;
        // Any actual damage at 0HP causes a failure, including damage absorbed by temporary HP.
        if (old == 0)
        {
            state.Stable = false; state.DeathFailures += critical ? 2 : 1;
            if (amount >= u.MaxHitPoints || state.DeathFailures >= 3) Die(c, u);
        }
        else
        {
            u.HitPoints = Math.Max(0, old - remaining);
            if (u.HitPoints == 0 && monster == "xmm:zombie" && type != "Radiant" && !critical)
            {
                int dc = 5 + amount, die = Roll(20); bool success = die + 3 >= dc;
                if (success) u.HitPoints = 1;
                Add(c, "undead_fortitude", u.Id, $"Undead Fortitude：CON d20 [{die}] +3 = {die + 3} vs DC{dc}；" + (success ? "降至1HP而非0。" : "失败。"),
                    check: new("constitution", "Undead Fortitude", [die], die, 3, die + 3, dc, success, "normal", Source: "XMM", TestKind: "save"),
                    displayText: success ? u.Name + "勉强撑住，没有倒下。" : u.Name + "未能撑住这次重创。");
            }
            if (u.HitPoints == 0)
            {
                Fall(c, u);
                if (Enemy(u) || remaining - old >= u.MaxHitPoints) Die(c, u);
            }
        }
        SyncCharacter(c, u);
        Add(c, "damage", u.Id, $"{u.Name}承受{amount}点{type}伤害（临时HP吸收{absorbed}）；HP {u.HitPoints}/{u.MaxHitPoints}，临时HP {state.TemporaryHitPoints}。",
            displayText: $"{u.Name}受到{amount}点伤害" + (absorbed > 0 ? $"，临时防护吸收{absorbed}点" : "") +
                (state.Dead ? "，已死亡。" : u.HitPoints == 0 ? "，倒地昏迷。" : "。"));
        if (concentrationCheck && !Enemy(u) && ConcentrationEffects.Current(c, PartyEngine.CharacterFor(c, u.Id)) is not null)
        {
            int dc = Math.Min(30, Math.Max(10, amount / 2));
            c.StandardCombatFlow!.Steps.Insert(0, new() { Kind = "concentration", ActorId = u.Id, TargetId = u.Id, SaveDc = dc });
            Board(c).Standard!.Wait = new("concentration", u.Id, u.Id, $"承受{amount}伤害（含临时HP吸收）后，等待本人确认DC{dc} Constitution专注豁免，或主动结束专注。");
            Add(c, "concentration_wait", u.Id, Board(c).Standard!.Wait!.Description, displayText: u.Name + "受伤后等待专注豁免。");
        }
        return amount;
    }
    private static int Heal(Campaign c, CombatUnit u, int amount)
    {
        if (Body(u).Dead) return 0;
        int actual = Math.Min(Math.Max(0, amount), u.MaxHitPoints - u.HitPoints);
        int previousSpeed = Speed(c, u);
        u.HitPoints += actual;
        if (actual > 0)
        {
            Body(u).DeathSuccesses = Body(u).DeathFailures = 0; Body(u).Stable = false;
            if (Body(u).ZeroHitPointUnconscious) RemoveCondition(c, u, "Unconscious");
            Body(u).ZeroHitPointUnconscious = false;
            if (Board(c).ActiveActorId == u.Id) u.MovementRemaining += Math.Max(0, Speed(c, u) - previousSpeed) * (1 + Body(u).DashesThisTurn);
        }
        SyncCharacter(c, u); return actual;
    }
    private void DeathSave(Campaign c, CombatUnit u)
    {
        int roll = Roll(20), modifier = -2 * Exhaustion(c, u) + (Enemy(u) ? 0 : WearableEquipment.SaveBonus(PartyEngine.CharacterFor(c, u.Id)));
        if (roll == 20) Heal(c, u, 1);
        else
        {
            if (roll == 1) Body(u).DeathFailures += 2;
            else if (roll + modifier >= 10) Body(u).DeathSuccesses++;
            else Body(u).DeathFailures++;
            if (Body(u).DeathFailures >= 3) Die(c, u);
            else if (Body(u).DeathSuccesses >= 3) MakeStable(c, u);
        }
        Add(c, "death_save", u.Id, $"{u.Name}死亡豁免 d20 [{roll}] {modifier:+0;-0;0}；" +
            (Body(u).Dead ? "已经死亡。" : u.HitPoints > 0 ? "自然20恢复1HP，仍倒地。" : Body(u).Stable ? "已稳定，仍0HP昏迷；累计重置。" : $"成功{Body(u).DeathSuccesses}、失败{Body(u).DeathFailures}。"),
            check: new("", "Death Saving Throw", [roll], roll, modifier, roll + modifier, 10, roll == 20 || roll != 1 && roll + modifier >= 10, "normal", TestKind: "save"),
            displayText: u.Name + "进行死亡豁免，" + (Body(u).Dead ? "未能撑住，已经死亡。" : u.HitPoints > 0 ? "恢复1点生命，苏醒但仍倒地。" :
                Body(u).Stable ? "伤势稳定，仍未苏醒。" : $"累计成功{Body(u).DeathSuccesses}次、失败{Body(u).DeathFailures}次。"));
        if (u.HitPoints == 0) Queue(c, new() { Kind = "advance", ActorId = u.Id });
    }
    private static void MakeStable(Campaign c, CombatUnit u)
    {
        Body(u).Stable = true; Body(u).DeathSuccesses = Body(u).DeathFailures = 0; SyncCharacter(c, u);
    }
    private void Stabilize(Campaign c, CombatUnit actor, CombatUnit target)
    {
        var ch = PartyEngine.CharacterFor(c, actor.Id);
        var check = new RulesEngine(dice).SheetTest(ch, new("medicine", "Medicine", "wisdom", "Medicine", 0, false), "normal");
        check = check with { Dc = 10, HasDc = true, Success = check.Total >= 10 };
        if (check.Success) MakeStable(c, target);
        Add(c, "stabilize", actor.Id, $"{actor.Name}急救{target.Name}：d20 [{string.Join(",", check.Rolls)}] {check.Modifier:+0;-0;0} = {check.Total} vs DC10；" +
            (check.Success ? "目标已稳定，仍0HP昏迷。" : "未能稳定，未恢复HP。"), check: check, target: target.Id,
            displayText: actor.Name + "急救" + target.Name + (check.Success ? "，使其伤势稳定，仍未苏醒。" : "，未能稳定伤势。"));
    }
}
