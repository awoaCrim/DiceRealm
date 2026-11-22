namespace DiceRealm.Server.Domain;

public sealed record PendingAbilityCheck(string Kind, string SceneId, DiceCheck Check, string ActionId = "");

// Imported milestone gates the implemented level-2 rule progression.
// No client-provided HP, proficiency, spell slots or XP are accepted.
public sealed class GrowthEngine(IDice dice)
{
    public static readonly string[] Kinds = ["growth.level2", "character.tactical_mind"];
    public static ActionChoice[] Choices(Campaign c)
    {
        if (CombatEngine.Restricted(c) || c.ActingCharacter.Build is not null) return []; // Full-builder acquisition currently ends at level 1; never apply preset level-2 choices.
        var result = new List<ActionChoice>();
        if (c.ActingCharacter.ClassName == "Fighter" && c.ActingCharacter.Level >= 2 && c.ActingPendingAbilityCheck is not null && CharacterEngine.Value(c.ActingCharacter, "Second Wind") > 0)
            result.Add(new("character.tactical_mind", "", "Tactical Mind / 为刚才的失败检定加 1d10"));
        if (c.ActingCharacter.Level != 1 || !ContentRuntime.SafeRest(c) || c.Adventure?.Level2Milestone is not { } milestone || !ContentRuntime.Matches(c, milestone)) return result.ToArray();
        if (c.ActingCharacter.ClassName == "Fighter") result.Add(new("growth.level2", "fixed", "里程碑升至 Fighter 2 / 固定 HP"));
        if (c.ActingCharacter.ClassName == "Wizard")
            foreach (var skill in c.ActingCharacter.Skills.Where(s => new[] { "Arcana", "History", "Investigation", "Medicine", "Nature", "Religion" }.Contains(s)))
                result.Add(new("growth.level2", skill, "升至 Wizard 2 / Scholar: " + skill));
        return result.ToArray();
    }
    public Resolution Resolve(Campaign c, string kind, string target)
    {
        if (!Choices(c).Any(a => a.Kind == kind && a.Target == target)) throw new GameException("action_unavailable", "尚未达到此里程碑，或此成长选项不可用。", 409);
        if (kind == "character.tactical_mind")
        {
            var pending = c.ActingPendingAbilityCheck!; c.ActingPendingAbilityCheck = null;
            int roll = dice.Roll(10); if (roll is < 1 or > 10) throw new InvalidOperationException("Invalid dice source.");
            var check = pending.Check with { Total = pending.Check.Total + roll, Success = pending.Check.Total + roll >= pending.Check.Dc,
                BonusRolls = [roll], BonusSource = "Tactical Mind" };
            string consequence = check.Success ? ContentRuntime.CorrectCheck(c, pending.ActionId) : "仍未通过检定；不消耗 Second Wind，本次不能再次追加 Tactical Mind。";
            if (check.Success) CharacterEngine.Change(c, "Second Wind", -1);
            return new("resolved", kind, $"Tactical Mind：原结果 {pending.Check.Total} + d10 [{roll}] = {check.Total} vs DC {check.Dc}。" +
                (check.Success ? "消耗 1 次 Second Wind。" : "") + consequence, check, check.Success ? ["check:success", "Second Wind:-1"] : []);
        }
        var ch = c.ActingCharacter;
        bool wizard = ch.ClassName == "Wizard";
        int hp = (wizard ? 4 : 6) + CharacterEngine.Ability(ch, "constitution");
        var resources = ch.Resources.Select(r => r.Name == CharacterEngine.HitDie(ch) || (wizard && r.Name == "Spell Slots (1st)")
            ? r with { Maximum = r.Maximum + 1, Current = r.Current + 1 } : r).ToList();
        if (!wizard) resources.Add(new("Action Surge", 1, 1));
        var spells = ch.Spellcasting;
        if (wizard) spells = spells! with { Spells = [..spells.Spells,
            new("feather-fall", "Feather Fall", 1, true, false, "Reaction", "Level 2 fixed spellbook selection · 需 DM 裁定"),
            new("thunderwave", "Thunderwave", 1, false, false, "Action", "Level 2 fixed spellbook selection · 未准备；需 DM 裁定")] };
        c.ActingCharacter = ch with { Level = 2, MaxHitPoints = ch.MaxHitPoints + hp, HitPoints = ch.HitPoints + hp,
            Resources = resources.ToArray(), Spellcasting = spells, Expertise = wizard ? [target] : [],
            PlayState = ch.PlayState is null ? null : ch.PlayState with {PreparedSpells=spells?.Spells.Where(s=>s.Prepared&&s.Level>0).Select(s=>s.Id).ToArray()??[],PreparationOpen=false},
            Features = [..ch.Features, wizard ? "Scholar: Expertise in " + target : "Action Surge: 1 extra non-Magic action per Short/Long Rest",
                wizard ? "Spellbook: 8 level-1 spells; 5 prepared; 3 level-1 slots" : "Tactical Mind: optional d10 after a failed supported ability check; spends Second Wind only if it succeeds"] };
        CharacterEngine.Sync(c);
        return new("resolved", kind, $"剧本里程碑：升至 {ch.ClassName} 2。固定 HP 增加 {hp}，保留原有伤势；获得 1 颗新的生命骰。" +
            (wizard ? $"Scholar 选择 {target} 专精；增加一个 1 环位，法术书新增 Feather Fall 与 Thunderwave，准备 Feather Fall。未恢复原先消耗的法术位。" : "获得 Action Surge 与 Tactical Mind；没有刷新 Second Wind。"), null, ["level:2"]);
    }
    public static void AfterAction(Campaign c, Resolution result)
    {
        // This reaction to a check is deliberately immediate. Choosing any other resolved
        // action closes the opportunity, and a Tactical Mind roll can never create another.
        if (result.Status != "resolved") return;
        // A shared-world action closes everyone else's immediate check opportunity.
        if (!PartyEngine.IsHost(c)) c.PendingAbilityCheck = null;
        foreach (var member in c.PartyMembers.Where(m => m.Id != c.ActingActorId)) member.PendingAbilityCheck = null;
        c.ActingPendingAbilityCheck = result.Check is { Success: false } check && c.ActingCharacter.ClassName == "Fighter" && c.ActingCharacter.Level >= 2 &&
            CharacterEngine.Value(c.ActingCharacter, "Second Wind") > 0 && result.ContentActionId.Length > 0 && ContentRuntime.Scene(c)?.Actions.FirstOrDefault(a => a.Id == result.ContentActionId)?.Failure.Effects.Length == 0
                ? new(result.Kind, c.SceneId, check, result.ContentActionId) : null;
    }
}

