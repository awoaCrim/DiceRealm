namespace DiceRealm.Server.Domain;

// Standard-mode operations never enter the historical nonlethal engine. The queue belongs
// to the campaign transaction; it pauses before a player's reaction or required roll.
public sealed partial class StandardCombatEngine(IDice dice)
{
    public const string Mode = "standard-2024";
    public static bool IsStandard(Campaign c) => c.Combat?.Standard is not null;
    public static bool Uses(Campaign c, string kind) => kind == "combat.start"
        ? ContentRuntime.AvailableEncounter(c)?.Mode == Mode : IsStandard(c) && kind.StartsWith("combat.", StringComparison.Ordinal);
    private static CombatState Board(Campaign c) => c.Combat!;
    private static StandardCombatUnit Body(CombatUnit u) => u.Standard!;
    private static CombatUnit Unit(Campaign c, string id) => Board(c).Units.Single(u => u.Id == id);
    private static ContentEncounter Definition(Campaign c) => ContentRuntime.FindEncounter(c, Board(c).DefinitionId)!;
    private static bool Enemy(CombatUnit u) => u.Team == "enemy";
    private static bool Incapacitated(CombatUnit u) => Body(u).Conditions.Any(s => s is "Unconscious" or "Incapacitated" or "Paralyzed" or "Stunned" or "Petrified");
    private static bool Able(CombatUnit u) => !u.Withdrawn && !Body(u).Dead && u.HitPoints > 0 && !Incapacitated(u);
    private static bool Dying(CombatUnit u) => !u.Withdrawn && !Body(u).Dead && !Body(u).Stable && u.HitPoints == 0;
    private static bool Boundary(CombatState b, CombatUnit u) => u.X == 0 || u.Y == 0 || u.X == b.Width - 1 || u.Y == b.Height - 1;
    private static int Exhaustion(Campaign c, CombatUnit u) => Enemy(u) ? 0 : PartyEngine.CharacterFor(c, u.Id).Exhaustion;
    private static int Speed(Campaign c, CombatUnit u) => Incapacitated(u) && Body(u).Conditions.Any(s => s is "Unconscious" or "Paralyzed" or "Petrified")
        ? 0 : Math.Max(0, u.Speed - 5 * Exhaustion(c, u) - (HasMasteryEffect(u, "slow") ? 10 : 0));
    private static void Dash(Campaign c, CombatUnit u) { u.MovementRemaining += Speed(c, u); Body(u).DashesThisTurn++; }
    private static bool Sees(Campaign c, CombatUnit a, CombatUnit z) => KnownTarget(c, a, z) && !Body(a).Conditions.Contains("Blinded") &&
        !EncounterConcealment.IsHidden(c, z.BoardEntityId ?? z.Id) && CombatGeometry.Cover(Board(c), a, z) != 99;
    private static bool KnownTarget(Campaign c, CombatUnit observer, CombatUnit target) => target.Team != "enemy" || target.BoardEntityId is null ||
        c.Board!.Entities.Single(e => e.Id == target.BoardEntityId).Appearance.Visibility == "player" || EncounterConcealment.KnownTo(c, target.BoardEntityId, observer.Id);
    // Candidate labels are player-facing. Keep mechanical sight/knowledge unchanged.
    private static bool PresentedTarget(Campaign c, CombatUnit observer, CombatUnit target) => target.Team != "enemy" || target.BoardEntityId is null ||
        c.Board!.Entities.Single(e => e.Id == target.BoardEntityId).Appearance.Visibility == "player" || EncounterConcealment.PresentedTo(c, target.BoardEntityId, observer.Id);
    public static bool CanStart(Campaign c) => PartyEngine.Characters(c).Where(p => !GameLifecycle.Dead(c, p.Id)).All(p => p.Character.HitPoints > 0 && p.Character.Exhaustion < 6 &&
        !p.Character.Conditions.Any(s => s is not ("Deafened" or "Poisoned" or "Blinded")));
    public static ActionChoice[] Choices(Campaign c)
    {
        if (!IsStandard(c) || NarrationPending(c) || CanContinueNarrated(c)) return [];
        var b = Board(c);
        // A character admitted after this battle has no historical unit or recovery action.
        if (b.Status != "active" && !b.Units.Any(u => u.Id == c.ActingActorId)) return [];
        var p = Unit(c, c.ActingActorId);
        ActionChoice[] end = ConcentrationEffects.Current(c, c.ActingCharacter) is not null ?
            [Choice("combat.concentration_end", "", "主动结束专注", p.Name, "不消耗动作、不掷骰", "立即结束当前专注效果；不退还资源。")] : [];
        if (b.Status != "active") return p.HitPoints == 0 && c.ActingCharacter.HitPoints == 0 && Body(p).Stable && !Body(p).Dead && !c.ActingCharacter.Conditions.Contains("Dead")
            ? [Choice("combat.recover_stable", "", "稳定后恢复意识", p.Name, "1d4 小时（本人确认后掷骰）", "恢复 1 HP，仍倒地；不恢复资源或自动复活。")]
            : end;
        if (b.Standard!.Wait is { } wait)
        {
            if (wait.ActorId != p.Id) return end;
            if (wait.Kind == "missile-allocation") return MissileChoices(c, p).Concat(end).ToArray();
            if (wait.Kind == "shield") return CastOptions(c, p, true).Select(o => SpellChoice(c, o, true)).Concat([
                Choice("combat.react", "pass", "放弃Shield反应", p.Name, "不消耗反应/资源", "继续已命中的原攻击，尚未投掷伤害骰。")]).Concat(end).ToArray();
            if (wait.Kind == "area-save") return new[] {
                Choice("combat.area_save", "", "区域效果 / 本人豁免", p.Name, "当前法术的对应豁免；无动作消耗", wait.Description)
            }.Concat(end).ToArray();
            if (wait.Kind == "concentration") return new[] {
                Choice("combat.concentration_save", "", "维持专注 / CON豁免", p.Name, "受伤后的专注豁免", wait.Description)
            }.Concat(end).ToArray();
            if (wait.Kind == "death") return [Choice("combat.death_save", "", "进行死亡豁免", p.Name, "开始回合的死亡豁免", "本人确认后掷 d20；自然1两次失败，自然20恢复1HP；三次成功稳定、三次失败死亡。")];
            if (wait.Kind == "opportunity") return new ActionChoice[]
            {
                Choice("combat.react", "attack", "借机攻击 / " + Unit(c, wait.TargetId).Name, Unit(c, wait.TargetId).Name, "1 次反应；一次近战攻击", wait.Description),
                Choice("combat.react", "pass", "放弃此次借机攻击", Unit(c, wait.TargetId).Name, "不消耗反应、不掷骰", "敌人将继续原移动；这只放弃当前触发。")
            }.Concat(OptionalMastery(c, p, Unit(c, wait.TargetId)) ? new[] {
                Choice("combat.react", "attack/mastery", "借机攻击并使用精通 / " + Unit(c, wait.TargetId).Name, Unit(c, wait.TargetId).Name, "1 次反应；一次近战攻击", MasteryNote(c, p))
            } : []).Concat(end).ToArray();
            return [];
        }
        if (b.ActiveActorId != p.Id) return end;
        var result = new List<ActionChoice>(end);
        if (Able(p))
        {
            result.AddRange(CastOptions(c, p).Select(o => SpellChoice(c, o)));
            if (p.BonusActionAvailable && ConcentrationEffects.Has(c, c.ActingCharacter, "expeditious-retreat"))
                result.Add(Choice("combat.quick_dash", "", "Expeditious Retreat / 附赠Dash", p.Name, "1附赠动作", "专注法术持续期间，增加当前速度的移动额度。"));
            foreach (var (x, y) in CombatGeometry.Steps(b, p).Where(s => CombatGeometry.StepCost(b, p, s.X, s.Y) <= p.MovementRemaining))
                result.Add(Choice("combat.move", $"{x},{y}", $"移动至 {x},{y}", $"格子 ({x},{y})", CombatGeometry.StepCost(b, p, x, y) + " 尺移动", "离开可见敌人触及可能触发反应，倒地时爬行每格额外5尺。"));
            if (Body(p).Conditions.Contains("Prone") && Speed(c, p) > 0 && p.MovementRemaining >= Speed(c, p) / 2)
                result.Add(Choice("combat.stand", "", "起身", p.Name, Speed(c, p) / 2 + " 尺移动", "只结束倒地，不自动捡回武器。"));
            if (p.ActionAvailable || Body(p).AttacksRemaining > 0)
                foreach (var z in b.Units.Where(u => Enemy(u) && !u.Withdrawn && !Body(u).Dead && PresentedTarget(c, p, u) && CanMelee(c, p, u)))
                {
                    string cost = Body(p).AttacksRemaining > 0 ? "本次 Attack 动作剩余攻击 ×1" : "1 个 Attack 动作（逐次选择攻击目标）";
                    result.Add(Choice("combat.attack", z.Id, Weapon(c, p)!.Name + " / " + z.Name, z.Name, cost,
                        "基本武器攻击；由当前装备、熟练及已实现特性计算。Sap/Vex在符合条件时生效，可选精通另选。" + CoverText(b, p, z)));
                    if (OptionalMastery(c, p, z)) result.Add(Choice("combat.attack", "mastery/" + z.Id, Weapon(c, p)!.Name + " + 精通 / " + z.Name, z.Name, cost, MasteryNote(c, p) + CoverText(b, p, z)));
                }
            if (p.ActionAvailable)
            {
                if (RuntimeEncounters.Current(c) is not null)
                    result.Add(Choice("combat.search", "", "Search / 搜寻", p.Name, "1 个动作；Wisdom (Perception)", "本人确认后与预览所示的已保存隐匿阈值比较；发现仅供本人和主持。"));
                result.Add(Choice("combat.dodge", "", "Dodge / 闪避", p.Name, "1 个动作", "可见攻击具有劣势，DEX豁免优势；失能或速度0时失效。"));
                result.Add(Choice("combat.dash", "", "Dash / 疾走", p.Name, "1 个动作", "本回合增加 " + Speed(c, p) + " 尺移动。"));
                result.Add(Choice("combat.disengage", "", "Disengage / 撤离", p.Name, "1 个动作", "本回合移动不触发借机攻击。"));
                foreach (var z in b.Units.Where(u => !Enemy(u) && Dying(u) && CombatGeometry.Reach(b, p, u)))
                    result.Add(Choice("combat.stabilize", z.Id, "急救稳定 / " + z.Name, z.Name, "1 个 Help 动作；DC10 Wisdom (Medicine)", "确认后检定；成功稳定，不恢复HP、不让目标自动起身。"));
                foreach (var item in Body(p).DroppedItems.Where(item => CanPickUp(c, p, item)))
                    result.Add(Choice("combat.pick_up", PickTarget(item), "拾回并准备掉落物品", p.Name, "1 个 Utilize 动作（本实现的明确拾取方式）", "只允许拾回在本格掉落的自身物品；不会给不存在的物品。"));
            }
            var ch = c.ActingCharacter;
            if (p.BonusActionAvailable && NaturalActions.ClassLevel(ch, "fighter") > 0 && CharacterEngine.Value(ch, "Second Wind") > 0 && p.HitPoints < p.MaxHitPoints)
                result.Add(Choice("combat.second_wind", "", "Second Wind / 回气", p.Name, "1 附赠动作 + Second Wind ×1", "1d10 + Fighter 职业等级，保持临时HP。"));
            if (!p.ActionAvailable && !Body(p).ActionSurgeUsed && NaturalActions.ClassLevel(ch, "fighter") >= 2 && CharacterEngine.Value(ch, "Action Surge") > 0)
                result.Add(Choice("combat.action_surge", "", "Action Surge / 动作如潮", p.Name, "Action Surge ×1；每回合一次", "额外一个非 Magic 动作；不重置每回合特性限额。"));
            if (Boundary(b, p) && p.MovementRemaining >= 5)
                result.Add(Choice("combat.retreat", "", "离开棋盘 / 撤退", p.Name, "5 尺移动", "按明确向外一步检查借机攻击；本场敌人不追击区域外角色。"));
        }
        result.Add(Choice("combat.end_turn", "", "结束回合", p.Name, "放弃当前剩余额度", "敌人继续行动；需要玩家回应时暂停，不代玩家掷骰。"));
        return result.ToArray();
    }
    public static bool ExpandedChoice(Campaign c, ActionChoice a) => IsStandard(c) &&
        (a.Kind is "combat.missile_allocate" or "combat.missile_cast" || a.Kind == "combat.attack" && a.Target.StartsWith("mastery/", StringComparison.Ordinal) ||
         a.Kind == "combat.react" && a.Target == "attack/mastery" || a.Kind == "combat.cast" && CastOptions(c, Unit(c, c.ActingActorId)).Any(o => o.Key == a.Target && o.Source.SpellId is "acid-splash" or "magic-missile"));
    private static string PickTarget(StandardDroppedItem item) => item.Slot is null ? item.Id : item.Slot + ":" + item.Id;
    private static bool CanPickUp(Campaign c, CombatUnit p, StandardDroppedItem item)
    {
        var ch = PartyEngine.CharacterFor(c, p.Id); var equipment = PlayCatalog.Equipment(item.Id);
        if (item.Slot is { } slot)
        {
            var l = EquipmentLoadout.Read(ch); var next = EquipmentLoadout.Set(l, slot, item.Id);
            int remaining = Body(p).DroppedItems.Count(d => d.Id == item.Id && d != item);
            int held = EquipmentLoadout.HandSlots.Count(s => s.StartsWith(l.ActiveSet + "-", StringComparison.Ordinal) && EquipmentLoadout.Id(next, s) == item.Id);
            return slot.StartsWith(l.ActiveSet + "-", StringComparison.Ordinal) && EquipmentLoadout.Id(l, slot) == "" &&
                p.X == item.X && p.Y == item.Y && EquipmentLoadout.Validate(ch, next) == "" &&
                (ch.Inventory.SingleOrDefault(i => i.Id == item.Id)?.Quantity ?? 0) >= held + remaining;
        }
        return p.X == item.X && p.Y == item.Y && equipment is not null &&
            ch.Inventory.Any(i => i.Id == item.Id && i.Quantity > 0 && !i.Equipped) &&
            PlayCatalog.EquipmentBlock(ch, equipment, true) == "" &&
            (equipment.WeaponCategory == "" || PlayCatalog.ActiveWeapon(ch) is null);
    }
    private static ActionChoice Choice(string kind, string target, string label, string name, string cost, string note) => new(kind, target, label,
        new(name, cost, "标准2024模式 · 每格5尺", note));
    private static string CoverText(CombatState b, CombatUnit p, CombatUnit z) => CombatGeometry.Cover(b, p, z) switch
    { 2 => " 目标半掩护：AC/DEX豁免+2。", 5 => " 目标四分之三掩护：AC/DEX豁免+5。", 99 => " 全掩护，不能直接攻击。", _ => " 无掩护。" };
    public static string? RollDescription(Campaign c, Intent action) => Uses(c, action.Kind) ? action.Kind switch
    {
        "combat.start" => "标准致命遭遇：全队分别确认后掷先攻；可能受到致命伤害、倒地与死亡。",
        "combat.attack" => "本人确认后投掷当前攻击和命中伤害；若触发对方反应则先暂停。",
        "combat.react" when action.Target != "pass" => "本人确认后执行所选反应，结算候选列出的来源和资源，随后继续原触发一次。",
        "combat.cast" when CastOptions(c, Unit(c, c.ActingActorId)).Any(o => o.Key == action.Target && o.Source.SpellId == "magic-missile") => null,
        "combat.missile_cast" => "本人确认完整飞弹分配后消耗Magic动作和原来源；所有Shield反应前不掷伤害，未被Shield阻挡的飞弹各1d4+1 Force并同时命中。",
        "combat.cast" => "本人确认候选所列的来源、目标、成分和资源后施放；治疗骰和后续效果由服务端结算。",
        "combat.area_save" => "本人确认后结算当前区域效果的豁免和伤害；取消请求不会取消已施放的法术。",
        "combat.concentration_save" => "本人确认后进行受伤的CON专注豁免；取消投掷不会消除该等待，可以明确结束专注。",
        "combat.death_save" => "本人确认后进行此次死亡豁免；放弃投掷请求不会消除仍需处理的伤势。",
        "combat.stabilize" => "本人确认后投掷 DC10 Wisdom (Medicine) 急救检定，并消耗一个动作。",
        "combat.search" => "本人确认后投掷 Wisdom (Perception)，消耗一个Search动作并与预览所示的已保存阈值比较；发现仅供本人和主持。",
        "combat.second_wind" => "本人确认后投掷恢复骰，并消耗本次附赠动作与资源。",
        "combat.recover_stable" => "本人确认后掷1d4，经过对应小时后恢复1HP；并非短休/长休，不恢复其他资源。",
        _ => null
    } : null;
    public static RollPreview? PreviewRoll(Campaign c, Intent action)
    {
        if (!Uses(c, action.Kind) || !CombatEngine.InCombat(c)) return null;
        var p = Unit(c, c.ActingActorId); var ch = c.ActingCharacter;
        var step = c.StandardCombatFlow?.Steps.FirstOrDefault();
        RollPreview Sheet(string ability, string skill, bool save, int? dc, string mode = "normal") => new(
            ability, skill, save ? "save" : "ability", RulesEngine.TestModifier(ch, ability, skill, save),
            RulesEngine.SheetTestMode(ch, ability, skill, save, mode), dc.HasValue, dc ?? 0, !dc.HasValue);
        return action.Kind switch
        {
            "combat.search" => Sheet("wisdom", "Perception", false, null) with { DifficultyClasses = EncounterConcealment.Difficulties(c) },
            "combat.stabilize" => Sheet("wisdom", "Medicine", false, 10),
            "combat.death_save" => new("", "Death Saving Throw", "save", -2 * Exhaustion(c, p) + WearableEquipment.SaveBonus(ch), "normal", true, 10, false),
            "combat.concentration_save" when step is { Kind: "concentration" } => Sheet("constitution", "", true, step.SaveDc,
                ch.BuildMechanics?.Feats.Contains("war-caster") == true ? "advantage" : "normal"),
            "combat.area_save" when step?.Area is { } area => Sheet(area.Ability, "", true, area.Dc,
                area.Ability == "dexterity" && p.Dodging && Able(p) && Speed(c, p) > 0 ? "advantage" : "normal")
                with { Modifier = RulesEngine.TestModifier(ch, area.Ability, "", true) + area.CoverBonus },
            _ => null
        };
    }
    public Resolution Resolve(Campaign c, string kind, string target, int namingVersion = NpcNames.Version)
    {
        bool writeBoard = kind == "combat.start" || CombatEngine.InCombat(c);
        var result = ResolveCore(c, kind, target, namingVersion);
        if (writeBoard) BoardCombat.Commit(c);
        return result;
    }
    private Resolution ResolveCore(Campaign c, string kind, string target, int namingVersion)
    {
        if (kind == "combat.start")
        {
            if (ContentRuntime.AvailableEncounter(c)?.Mode != Mode || !CanStart(c)) throw Unavailable();
            Start(c, namingVersion);
            return Result(c, kind, 0);
        }
        if (!Choices(c).Any(a => a.Kind == kind && a.Target == target)) throw Unavailable();
        var b = Board(c); var p = Unit(c, c.ActingActorId); int before = b.LogSequence;
        bool planEdit = IsUnpaidMissilePlan(c, new(kind, target));
        switch (kind)
        {
            case "combat.move":
                var xy = target.Split(',').Select(int.Parse).ToArray();
                Queue(c, new() { Kind = "move", ActorId = p.Id, X = xy[0], Y = xy[1] }); break;
            case "combat.retreat":
                var exit = Exit(b, p);
                Queue(c, new() { Kind = "retreat", ActorId = p.Id, X = exit.X, Y = exit.Y }); break;
            case "combat.attack":
                if (Body(p).AttacksRemaining == 0) { p.ActionAvailable = false; Body(p).AttacksRemaining = AttackCount(c.ActingCharacter); }
                Body(p).AttacksRemaining--;
                Attack(c, p, Unit(c, target.StartsWith("mastery/", StringComparison.Ordinal) ? target[8..] : target), false, target.StartsWith("mastery/", StringComparison.Ordinal)); break;
            case "combat.react":
                var wait = b.Standard!.Wait!;
                var step = c.StandardCombatFlow!.Steps[0];
                b.Standard.Wait = null;
                if (wait.Kind == "shield")
                {
                    if (step.Kind == "missile-shield") step.Reacted = [p.Id];
                    if (target != "pass")
                    {
                        var selected = CastOptions(c, p, true).Single(o => o.Key == target);
                        PaySpell(c, p, selected); p.ReactionAvailable = false; Body(p).ShieldActive = true;
                        Add(c, kind, p.Id, "施放Shield，消耗反应及 " + selected.Source.Resource + "；+5AC持续至自己下回合开始。", target: wait.TargetId,
                            displayText: p.Name + "施放「" + selected.Source.Name + "」保护自己。");
                    }
                    else Add(c, kind, p.Id, "放弃Shield，继续原攻击，未消耗反应/法术资源。", target: wait.TargetId,
                        displayText: p.Name + "放弃护盾反应。");
                }
                else
                {
                    step.Reacted = [.. step.Reacted, p.Id];
                    if (target is "attack" or "attack/mastery") { p.ReactionAvailable = false; Attack(c, p, Unit(c, wait.TargetId), true, target == "attack/mastery"); }
                    else Add(c, kind, p.Id, "放弃当前借机攻击，未消耗反应、未掷骰。", target: wait.TargetId,
                        displayText: p.Name + "放弃对" + Unit(c, wait.TargetId).Name + "的借机攻击。");
                }
                break;
            case "combat.cast": Cast(c, p, target); break;
            case "combat.missile_allocate": AllocateMissile(c, p, target); break;
            case "combat.missile_cast": ReleaseMissiles(c, p); break;
            case "combat.quick_dash": p.BonusActionAvailable = false; Dash(c, p); Add(c, kind, p.Id, "专注Expeditious Retreat期间使用附赠动作Dash。", displayText: p.Name + "加快脚步疾走。"); break;
            case "combat.area_save": AreaSave(c); break;
            case "combat.concentration_save": ConcentrationSave(c, p); break;
            case "combat.concentration_end":
                EndConcentration(c, p);
                if (b.Standard!.Wait is { Kind: "concentration" } cw && cw.ActorId == p.Id)
                { c.StandardCombatFlow!.Steps.RemoveAt(0); b.Standard.Wait = null; }
                break;
            case "combat.death_save":
                b.Standard!.Wait = null; DeathSave(c, p); break;
            case "combat.stabilize":
                p.ActionAvailable = false; Stabilize(c, p, Unit(c, target)); break;
            case "combat.search":
                p.ActionAvailable = false;
                var search = new RulesEngine(dice).SheetTest(c.ActingCharacter, new("", "", "wisdom", "Perception", 0, false), "normal")
                    with { HasDc = false, Dc = 0, Success = false, DifficultyClasses = EncounterConcealment.Difficulties(c) };
                EncounterConcealment.Search(c, RuntimeEncounters.Current(c)!.Definition.Id, b.Id + ":" + b.Standard!.TurnSerial + ":" + b.LogSequence, search.Total);
                Add(c, kind, p.Id, "消耗1个Search动作完成搜寻；发现记录仅供本人和主持。", check: search, displayText: p.Name + "搜寻周围。"); break;
            case "combat.stand":
                p.MovementRemaining -= Speed(c, p) / 2; RemoveCondition(c, p, "Prone");
                Add(c, kind, p.Id, "花费一半速度的移动额度起身；掉落物品未拾回。", displayText: p.Name + "站起身。"); break;
            case "combat.pick_up":
                p.ActionAvailable = false;
                var ch = c.ActingCharacter;
                var dropped = Body(p).DroppedItems.Single(item => PickTarget(item) == target);
                c.ActingCharacter = dropped.Slot is { } droppedSlot
                    ? EquipmentLoadout.Commit(ch, EquipmentLoadout.Set(EquipmentLoadout.Read(ch), droppedSlot, dropped.Id))
                    : PlayCatalog.SetEquipment(ch, dropped.Id, true);
                Body(p).DroppedItems = Body(p).DroppedItems.Where(item => item != dropped).ToArray();
                CharacterEngine.Sync(c);
                Add(c, kind, p.Id, "消耗 Utilize 动作，拾回并准备 " + target + "。", displayText: p.Name + "拾起掉落的装备。"); break;
            case "combat.dodge": p.ActionAvailable = false; p.Dodging = true; Add(c, kind, p.Id, "采取 Dodge。", displayText: p.Name + "采取闪避，留意来袭的攻击。"); break;
            case "combat.dash": p.ActionAvailable = false; Dash(c, p); Add(c, kind, p.Id, "Dash 增加移动额度。", displayText: p.Name + "疾走。"); break;
            case "combat.disengage": p.ActionAvailable = false; p.Disengaging = true; Add(c, kind, p.Id, "本回合移动不触发借机攻击。", displayText: p.Name + "谨慎撤离，避开借机攻击。"); break;
            case "combat.action_surge":
                CharacterEngine.Change(c, "Action Surge", -1); Body(p).ActionSurgeUsed = true; p.ActionAvailable = true; p.SurgeAction = true;
                Body(p).AttacksRemaining = 0; Add(c, kind, p.Id, "消耗 Action Surge ×1，获得额外非 Magic 动作。", displayText: p.Name + "奋力再行动一次。"); break;
            case "combat.second_wind":
                p.BonusActionAvailable = false; CharacterEngine.Change(c, "Second Wind", -1);
                int die = Roll(10), level = NaturalActions.ClassLevel(c.ActingCharacter, "fighter");
                int healed = Heal(c, p, die + level);
                Add(c, kind, p.Id, $"Second Wind：d10 [{die}] + Fighter {level}，实际恢复 {healed} HP。", displayText: $"{p.Name}回气，恢复{healed}点生命。"); break;
            case "combat.recover_stable":
                int hours = Roll(4); CharacterEngine.Advance(c, hours * 3600L); int recovered = Heal(c, p, 1);
                Add(c, kind, p.Id, $"稳定恢复：d4 [{hours}] 小时后恢复1HP，仍倒地；未恢复资源。", displayText: $"{hours}小时后，{p.Name}恢复{recovered}点生命，苏醒但仍倒地。"); break;
            case "combat.end_turn":
                Add(c, kind, p.Id, "结束当前回合。", displayText: p.Name + "结束回合。");
                Queue(c, new() { Kind = "advance", ActorId = p.Id }); break;
        }
        // Opening, editing or cancelling a Magic Missile plan spends nothing and changes no one: its
        // record stays in the battle log but is not a story beat. The paid cast narrates the volley.
        if (planEdit) AcknowledgeNarration(c);
        if (!Finish(c)) Continue(c);
        return Result(c, kind, before);
    }
    private static Resolution Result(Campaign c, string kind, int before)
    {
        var entries = Board(c).Log.Where(e => e.Sequence > before).ToArray();
        return new("resolved", kind, string.Join("\n", entries.Select(e => e.Text)), null, ["combat:" + Board(c).Status], CombatLog: entries);
    }
    private static GameException Unavailable() => new("action_unavailable", "当前触发、席位、装备、目标或回合资源不允许此标准战斗行动。", 409);
    private int Roll(int sides)
    {
        int value = dice.Roll(sides);
        return value >= 1 && value <= sides ? value : throw new InvalidOperationException("Invalid dice source.");
    }
    private static void Queue(Campaign c, StandardCombatStep step) => c.StandardCombatFlow!.Steps.Add(step);
    private static void Add(Campaign c, string kind, string actor, string text, AttackRoll? attack = null, DiceCheck? check = null,
        string? target = null, string[]? targets = null, string displayText = "")
    {
        var b = Board(c);
        var involved = CombatPresentation.Involved(actor, target, targets);
        var audience = CombatPresentation.Audience(c, involved);
        b.Log.Add(new(++b.LogSequence, b.Round, kind, actor, text, attack, Check: check, Audience: audience,
            Presentation: CombatPresentation.Capture(c, displayText, involved, audience)));
        if (b.Log.Count > 200) b.Log.RemoveRange(0, b.Log.Count - 200);
    }
}
