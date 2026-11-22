namespace DiceRealm.Server.Domain;

public sealed partial class StandardCombatEngine
{
    public static void ValidateState(Campaign c)
    {
        static void Require(bool valid)
        {
            if (!valid) throw new GameException("invalid_standard_combat", "标准战斗记录不完整或版本不受支持；保留原存档，请恢复一致备份或检查记录。", 409);
        }
        ConcentrationEffects.Validate(c);
        BoardCombat.ValidateState(c);
        var b = c.Combat;
        if (b?.Standard is null)
        {
            Require(c.StandardCombatFlow is null && (b?.Units?.All(u => u?.Standard is null) ?? true));
            return;
        }
        Require(b.Standard.SchemaVersion == 1 && b.Standard.TurnSerial > 0 && b.Round >= 1 &&
            b.Status is "active" or "victory" or "defeated" or "retreated" &&
            (b.BoardLayout is null ? b.Width == 7 && b.Height == 5 : b.Width == b.BoardLayout.Width && b.Height == b.BoardLayout.Height) && b.CellFeet == 5);
        Require(b.Cells is not null && b.Cells.Length <= b.Width * b.Height && b.Cells.All(cell => cell is not null && CombatGeometry.Inside(b, cell.X, cell.Y) &&
            cell.Terrain is "blocked" or "difficult" or "half-cover" or "three-quarters-cover") && b.Cells.Select(cell => (cell.X, cell.Y)).Distinct().Count() == b.Cells.Length);
        Require(b.Log is not null && b.Log.Count <= 200 && b.Log.All(e => e is not null && (e.Audience is null ||
            e.Audience.Distinct().Count() == e.Audience.Length && e.Audience.All(id => PartyEngine.Characters(c, true).Any(p => p.Id == id)))));
        var flow = c.StandardCombatFlow;
        Require(flow is not null && flow.SchemaVersion == 1 && flow.Steps is not null && flow.Steps.Count <= 64 &&
            (flow.NarratedThrough is null || flow.NarratedThrough >= 0 && flow.NarratedThrough <= b.LogSequence));
        Require(b.Units is { Length: >= 2 and <= 7 } && b.Units.All(u => u is not null && u.Standard is not null) &&
            b.TurnOrder is not null && b.TurnOrder.Length == b.Units.Length && b.Units.Select(u => u.Id).Distinct().Count() == b.Units.Length &&
            b.TurnOrder.Distinct().Count() == b.Units.Length && b.TurnOrder.All(id => b.Units.Any(u => u.Id == id)));
        var definition = ContentRuntime.FindEncounter(c, b.DefinitionId);
        Require(definition is not null && definition.Mode == Mode && !definition.Nonlethal);
        foreach (var u in b.Units!)
        {
            var state = u.Standard!;
            Require(u.Id is { Length: > 0 } && u.Team is "party" or "enemy" && CombatGeometry.Inside(b, u.X, u.Y) &&
                u.HitPoints >= 0 && u.HitPoints <= u.MaxHitPoints && u.MaxHitPoints > 0 && state.TemporaryHitPoints >= 0 &&
                state.DeathSuccesses is >= 0 and <= 2 && state.DeathFailures is >= 0 and <= 4 && state.AttacksRemaining is >= 0 and <= 4 && state.DashesThisTurn is >= 0 and <= 3 && state.SlotSpentTurn >= 0 && state.SlotSpentTurn <= b.Standard.TurnSerial &&
                state.Conditions is not null && state.Conditions.All(x => x is "Dead" or "Unconscious" or "Incapacitated" or "Paralyzed" or "Prone" or "Poisoned" or "Blinded" or "Deafened" or "Stunned") &&
                state.Conditions.Distinct().Count() == state.Conditions.Length && state.DroppedItems is not null && state.DroppedItems.Length <= 4 &&
                state.DroppedItems.All(x => x is not null && x.Id is { Length: > 0 } && (x.Slot is null || EquipmentLoadout.HandSlots.Contains(x.Slot)) && CombatGeometry.Inside(b, x.X, x.Y)) && state.DroppedItems.Select(x => (x.Id, x.Slot)).Distinct().Count() == state.DroppedItems.Length);
            Require(state.MasteryEffects is not null && state.MasteryEffects.Length <= 21 && state.MasteryEffects.All(e => e is not null &&
                e.Kind is "sap" or "slow" or "vex" && b.Units.Any(a => a.Id == e.SourceId && !Enemy(a) && a.Id != u.Id) &&
                (e.Kind == "vex" ? e.TurnEndsRemaining is 1 or 2 : e.TurnEndsRemaining == 0)) &&
                state.MasteryEffects.Select(e => (e.Kind, e.SourceId)).Distinct().Count() == state.MasteryEffects.Length);
            Require((!state.Stable || u.HitPoints == 0 && !state.Dead && state.DeathFailures == 0 && state.DeathSuccesses == 0) &&
                (!state.Dead || u.HitPoints == 0 && state.Conditions!.Contains("Dead")) &&
                (!state.ZeroHitPointUnconscious || u.HitPoints == 0 && state.Conditions!.Contains("Unconscious")) &&
                (u.HitPoints != 0 || state.Conditions!.Contains("Unconscious")));
            if (Enemy(u))
            {
                Require(definition!.Enemies.Any(e => e.Id == (b.BoardLayout is null ? u.Id : BoardCombat.EnemyProfile(c, u).Id)));
                var enemy = BoardCombat.EnemyProfile(c, u);
                Require(enemy.Tactic != "ranged" || StandardMonsters.IsGoblinWarrior(enemy));
            }
            else
            {
                Require(PartyEngine.Characters(c, true).Any(p => p.Id == u.Id));
                var ch = PartyEngine.CharacterFor(c, u.Id);
                // Closed boards are historical, except stable recovery explicitly updates both.
                if (b.Status == "active") Require(ch.HitPoints == u.HitPoints && ch.TemporaryHitPoints == state.TemporaryHitPoints && ch.Conditions.SequenceEqual(state.Conditions!));
                if (b.Status == "active") Require(state.DroppedItems!.All(item => ch.Inventory.Any(i => i.Id == item.Id && i.Quantity > 0)));
            }
        }
        foreach (var step in flow!.Steps!)
        {
            Require(step is not null && step.Kind is "move" or "retreat" or "attack" or "advance" or "hit" or "concentration" or "area-save" or "missile-allocation" or "missile-shield" or "missile-impact" && b.Units.Any(u => u.Id == step.ActorId) &&
                step.Reacted is not null && step.Reacted.Length <= 7 && step.Reacted.Distinct().Count() == step.Reacted.Length && step.Reacted.All(id => b.Units.Any(u => u.Id == id)));
            if (step!.Kind is "attack" or "hit" or "concentration" or "area-save" or "missile-allocation" or "missile-shield" or "missile-impact") Require(b.Units.Any(u => u.Id == step.TargetId));
            if (step.Kind == "attack")
            {
                var attacker = Unit(c, step.ActorId);
                var enemy = Enemy(attacker) ? BoardCombat.EnemyProfile(c, attacker) : null;
                bool ranged = enemy is { Tactic: "ranged" } && StandardMonsters.IsGoblinWarrior(enemy);
                Require(step.WeaponId == (ranged ? "shortbow" : null) && (!ranged || !Enemy(Unit(c, step.TargetId))));
            }
            else Require(step.WeaponId is null);
            if (step.Kind == "hit")
            {
                var strike = step.Strike;
                Require(strike is not null && strike.Dice is >= 1 and <= 40 && strike.Die is 4 or 6 or 8 or 10 or 12 &&
                    strike.AbilityModifier is >= -5 and <= 10 && (!strike.UseMastery || !Enemy(Unit(c, step.ActorId)) && OptionalMastery(c, Unit(c, step.ActorId), Unit(c, step.TargetId))) &&
                    strike.DamageType is "Bludgeoning" or "Piercing" or "Slashing" && strike.Roll is not null);
                var roll = strike!.Roll!;
                Require(roll.Rolls is { Length: 1 or 2 } && roll.Rolls.All(n => n is >= 1 and <= 20) && roll.Rolls.Contains(roll.Selected) &&
                    roll.Total == roll.Selected + roll.Modifier && roll.DamageRolls is { Length: 0 } && roll.AlternateRolls is { Length: 0 } && roll.EffectiveDice is { Length: 0 });
                var attacker = Unit(c, step.ActorId);
                var enemy = Enemy(attacker) ? BoardCombat.EnemyProfile(c, attacker) : null;
                if (enemy is not null && StandardMonsters.IsGoblinWarrior(enemy))
                {
                    Require(strike.WeaponId is "scimitar" or "shortbow" && !Enemy(Unit(c, step.TargetId)) &&
                        (strike.WeaponId == "shortbow" ? !strike.Opportunity && enemy.Tactic == "ranged" && strike.DamageType == "Piercing" :
                            (strike.Opportunity || enemy.Tactic != "ranged") && strike.DamageType == "Slashing") &&
                        strike.Dice == (roll.Critical ? 2 : 1) && strike.Die == 6 && roll.DamageModifier == 2 &&
                        !strike.Savage && !strike.GreatWeaponFighting && strike.GrazeDamage == 0 && !strike.UseMastery && strike.AbilityModifier == 0 &&
                        roll.Mode is "normal" or "advantage" or "disadvantage" && roll.Rolls.Length == (roll.Mode == "normal" ? 1 : 2) &&
                        roll.Selected == (roll.Mode == "advantage" ? roll.Rolls.Max() : roll.Mode == "disadvantage" ? roll.Rolls.Min() : roll.Rolls[0]) &&
                        (!roll.Critical || roll.Hit) && roll.Damage == 0 && !roll.Graze &&
                        (strike.AdvantageDamageDice is null or 1 or 2) &&
                        strike.AdvantageDamageDice == (roll.Mode == "advantage" ? roll.Critical ? 2 : 1 : (int?)null));
                }
                else Require(strike.WeaponId is null && strike.AdvantageDamageDice is null);
            }
            else Require(step.Strike is null);
            if (step.Kind == "area-save")
            {
                var area = step.Area;
                Require(area is not null && area.Dc is >= 1 and <= 40 && area.Damage is >= 0 and <= 60 && area.CoverBonus is 0 or 2 or 5 && (area.SpellId == "acid-splash" || area.CoverBonus == 0) &&
                    (area.SpellId == "thunderclap" && area.Ability == "constitution" && area.DamageType == "Thunder" && !area.HalfOnSave ||
                     area.SpellId == "arms-of-hadar" && area.Ability == "strength" && area.DamageType == "Necrotic" && area.HalfOnSave ||
                     area.SpellId == "acid-splash" && area.Ability == "dexterity" && area.DamageType == "Acid" && !area.HalfOnSave));
                Require(!Enemy(Unit(c, step.TargetId)) || StandardMonsters.Save(BoardCombat.EnemyProfile(c, Unit(c, step.TargetId)), area!.Ability) is not null);
            }
            else Require(step.Area is null);
            if (step.Kind is "missile-allocation" or "missile-impact")
            {
                var plan = step.Missiles;
                Require(plan is not null && plan.SourceKey is { Length: 70 } && plan.SourceKey.StartsWith("spell/", StringComparison.Ordinal) &&
                    plan.SlotLevel is >= 0 and <= 9 && plan.Count == 2 + Math.Max(1, plan.SlotLevel) && plan.Targets is not null && plan.Targets.Length <= plan.Count && plan.Targets.All(id => b.Units.Any(u => u.Id == id)) &&
                    (step.Kind == "missile-allocation" || plan.Targets.Length == plan.Count) && !Enemy(Unit(c, step.ActorId)) && step.TargetId == step.ActorId);
            }
            else Require(step.Missiles is null);
            if (step.Kind == "missile-shield") Require(!Enemy(Unit(c, step.TargetId)) &&
                flow.Steps.Any(s => s.Kind == "missile-impact" && s.ActorId == step.ActorId && s.Missiles?.Targets.Contains(step.TargetId) == true));
            if (step.Kind == "concentration") Require(step.SaveDc is >= 10 and <= 30 && step.ActorId == step.TargetId && !Enemy(Unit(c, step.ActorId)));
            if (step.Kind == "move") Require(CombatGeometry.Inside(b, step.X, step.Y));
            if (step.Kind == "retreat") Require(((step.X == -1 || step.X == b.Width) && step.Y >= 0 && step.Y < b.Height) ||
                ((step.Y == -1 || step.Y == b.Height) && step.X >= 0 && step.X < b.Width));
        }
        Require(b.Status == "active" ? b.Units.Any(u => u.Id == b.ActiveActorId) : b.ActiveActorId == "" && flow.Steps.Count == 0 && b.Standard.Wait is null);
        if (b.Standard.Wait is { } wait)
        {
            Require(b.Status == "active" && wait.Kind is "death" or "opportunity" or "shield" or "concentration" or "area-save" or "missile-allocation" && b.Units.Any(u => u.Id == wait.ActorId && !Enemy(u)) &&
                b.Units.Any(u => u.Id == wait.TargetId) && wait.Description is { Length: > 0 and <= 500 });
            var actor = Unit(c, wait.ActorId);
            if (wait.Kind == "death") Require(b.ActiveActorId == actor.Id && Dying(actor) && flow.Steps.Count == 0);
            else if (wait.Kind == "area-save") Require(flow.Steps.Count > 0 && flow.Steps[0].Kind == "area-save" && flow.Steps[0].TargetId == actor.Id &&
                flow.Steps[0].ActorId == wait.TargetId && !Body(actor).Dead && !actor.Withdrawn);
            else if (wait.Kind == "missile-allocation") Require(flow.Steps.Count == 1 && flow.Steps[0].Kind == "missile-allocation" &&
                flow.Steps[0].ActorId == actor.Id && wait.TargetId == actor.Id && b.ActiveActorId == actor.Id);
            else if (wait.Kind == "shield") Require(flow.Steps.Count > 0 && flow.Steps[0].ActorId == wait.TargetId && flow.Steps[0].TargetId == actor.Id &&
                (flow.Steps[0].Kind == "hit" && flow.Steps[0].Strike!.Roll.Hit || flow.Steps[0].Kind == "missile-shield" && !flow.Steps[0].Reacted.Contains(actor.Id)) &&
                !Body(actor).ShieldActive && CastOptions(c, actor, true).Length > 0);
            else if (wait.Kind == "concentration") Require(flow.Steps.Count > 0 && flow.Steps[0].Kind == "concentration" && flow.Steps[0].ActorId == actor.Id && wait.TargetId == actor.Id &&
                ConcentrationEffects.Current(c, PartyEngine.CharacterFor(c, actor.Id)) is not null);
            else Require(flow.Steps.Count > 0 && flow.Steps[0].Kind is "move" or "retreat" && flow.Steps[0].ActorId == wait.TargetId &&
                actor.ReactionAvailable && !Body(actor).ReactionsSuppressed && Able(actor) && !flow.Steps[0].Reacted.Contains(actor.Id) && CanMelee(c, actor, Unit(c, wait.TargetId)));
        }
        else Require(flow.Steps.Count == 0 || flow.NarratedThrough is not null && flow.Steps[0].Kind == "advance"); // Paused before the next unit or for a player response.
    }
}
