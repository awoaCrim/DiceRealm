using System.Diagnostics.CodeAnalysis;

namespace DiceRealm.Server.Domain;

public static class ContentValidator
{
    private const int MaxLongText = 8_000;
    private const int MaxPrompt = 16_000;

    public static void Validate(AdventureDocument document)
    {
        ValidateNotNull(document, "document");
        if (document.FormatVersion != 1) Invalid("formatVersion", "must be 1");

        ValidateId(document.Id, "id");
        ValidateRequiredOneLine(document.Version, 80, "version");
        ValidateRequiredOneLine(document.Name, 120, "name");
        ValidateId(document.StartSceneId, "startSceneId");
        ValidateText(document.SourceText, 200_000, "sourceText");
        ValidateOneLine(document.StyleProfile, 120, "styleProfile");

        var constraints = RequireArray(document.VisualConstraints, "visualConstraints");
        if (constraints.Length > 8) Invalid("visualConstraints", "must contain at most 8 entries");
        for (var i = 0; i < constraints.Length; i++)
            ValidateOneLine(constraints[i], 240, $"visualConstraints[{i}]");

        var scenes = RequireArray(document.Scenes, "scenes");
        var items = RequireArray(document.Items, "items");
        var quests = RequireArray(document.Quests, "quests");
        var npcs = RequireArray(document.Npcs, "npcs");
        var factions = RequireArray(document.Factions, "factions");
        var branches = RequireArray(document.Branches, "branches");

        if (scenes.Length is < 1 or > 200) Invalid("scenes", "must contain 1 to 200 entries");

        var sceneIds = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < scenes.Length; i++)
        {
            var path = $"scenes[{i}].id";
            ValidateId(scenes[i].Id, path);
            if (!sceneIds.Add(scenes[i].Id)) Invalid(path, "must be unique");
        }
        if (!sceneIds.Contains(document.StartSceneId)) Invalid("startSceneId", "must reference a scene");

        var itemIds = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < items.Length; i++)
        {
            var path = $"items[{i}]";
            ValidateId(items[i].Id, path + ".id");
            if (!itemIds.Add(items[i].Id)) Invalid(path + ".id", "must be unique");
            ValidateRequiredOneLine(items[i].Name, 120, path + ".name");
            if (items[i].RulesId is not null && !NaturalActions.SupportedItem(items[i].RulesId))
                Invalid(path + ".rulesId", "must reference a supported complete 2024 item effect");
        }

        var questIds = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < quests.Length; i++)
        {
            var path = $"quests[{i}].id";
            ValidateId(quests[i].Id, path);
            if (!questIds.Add(quests[i].Id)) Invalid(path, "must be unique");
        }

        var npcIds = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < npcs.Length; i++)
        {
            var path = $"npcs[{i}].id";
            ValidateId(npcs[i].Id, path);
            if (!npcIds.Add(npcs[i].Id)) Invalid(path, "must be unique");
        }

        var factionIds = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < factions.Length; i++)
        {
            var path = $"factions[{i}].id";
            ValidateId(factions[i].Id, path);
            if (!factionIds.Add(factions[i].Id)) Invalid(path, "must be unique");
        }

        if (document.Level2Milestone is not null)
            ValidateCondition(document.Level2Milestone, "level2Milestone", sceneIds);

        var actionIds = new HashSet<string>(StringComparer.Ordinal);
        var encounterIds = new HashSet<string>(StringComparer.Ordinal);
        var enemyIds = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < scenes.Length; i++)
            ValidateScene(scenes[i], $"scenes[{i}]", sceneIds, itemIds, actionIds, encounterIds, enemyIds);

        for (var i = 0; i < quests.Length; i++)
            ValidateQuest(quests[i], $"quests[{i}]", sceneIds);

        for (var i = 0; i < npcs.Length; i++)
            ValidateNpc(npcs[i], $"npcs[{i}]", sceneIds, factionIds);

        for (var i = 0; i < factions.Length; i++)
            ValidateFaction(factions[i], $"factions[{i}]", sceneIds);

        var branchPairs = new HashSet<(string Id, string Choice)>();
        for (var i = 0; i < branches.Length; i++)
        {
            var branch = branches[i];
            var path = $"branches[{i}]";
            ValidateId(branch.Id, path + ".id");
            ValidateId(branch.Choice, path + ".choice");
            ValidateRequiredOneLine(branch.Label, 160, path + ".label");
            ValidateCondition(branch.When, path + ".when", sceneIds);
            if (!branchPairs.Add((branch.Id, branch.Choice)))
                Invalid(path, "id and choice pair must be unique");
        }

        ValidateInitialKnowledge(document.InitialKnowledge, sceneIds);
        _ = AdventureOpenings.SelectScene(document);
    }

    // Optional, non-mechanical opening knowledge added by preparation. Null is the legacy shape
    // and keeps a document's serialized fingerprint unchanged.
    private static void ValidateInitialKnowledge(InitialKnowledgeEntry[]? entries, HashSet<string> sceneIds)
    {
        if (entries is null) return;
        var array = RequireArray(entries, "initialKnowledge");
        if (array.Length > 64) Invalid("initialKnowledge", "must contain at most 64 entries");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < array.Length; i++)
        {
            var entry = array[i];
            var path = $"initialKnowledge[{i}]";
            ValidateId(entry.Id, path + ".id");
            if (!ids.Add(entry.Id)) Invalid(path + ".id", "must be unique");
            if (entry.Kind is not ("npc" or "quest" or "place" or "clue"))
                Invalid(path + ".kind", "must be npc, quest, place, or clue");
            ValidateRequiredOneLine(entry.Name, 80, path + ".name");
            ValidateText(entry.Summary, 800, path + ".summary");
            ValidateNotNull(entry.SceneId, path + ".sceneId");
            if (entry.SceneId.Length > 0)
            {
                ValidateId(entry.SceneId, path + ".sceneId");
                if (!sceneIds.Contains(entry.SceneId)) Invalid(path + ".sceneId", "must reference a scene");
            }
            ValidateNotNull(entry.RevealSceneId, path + ".revealSceneId");
            if (entry.Visibility is not ("host" or "public" or "arrival"))
                Invalid(path + ".visibility", "must be host, public, or arrival");
            if (entry.Visibility == "arrival")
            {
                if (entry.RevealSceneId.Length == 0) Invalid(path + ".revealSceneId", "is required for arrival knowledge");
                ValidateId(entry.RevealSceneId, path + ".revealSceneId");
                if (!sceneIds.Contains(entry.RevealSceneId)) Invalid(path + ".revealSceneId", "must reference a scene");
            }
            else if (entry.RevealSceneId.Length != 0)
                Invalid(path + ".revealSceneId", "must be empty unless visibility is arrival");
        }
    }

    private static void ValidateScene(ContentScene scene, string path, HashSet<string> sceneIds,
        HashSet<string> itemIds, HashSet<string> actionIds, HashSet<string> encounterIds,
        HashSet<string> enemyIds)
    {
        ValidateRequiredOneLine(scene.Title, 160, path + ".title");
        ValidateText(scene.Summary, MaxLongText, path + ".summary");
        ValidateText(scene.Arrival, MaxLongText, path + ".arrival");
        ValidateText(scene.ImagePrompt, MaxPrompt, path + ".imagePrompt");
        if (!float.IsFinite(scene.X) || scene.X is < 0 or > 1) Invalid(path + ".x", "must be finite and between 0 and 1");
        if (!float.IsFinite(scene.Y) || scene.Y is < 0 or > 1) Invalid(path + ".y", "must be finite and between 0 and 1");

        var exits = RequireArray(scene.Exits, path + ".exits");
        if (exits.Length > 32) Invalid(path + ".exits", "must contain at most 32 entries");
        var exitTargets = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < exits.Length; i++)
        {
            var exit = exits[i];
            var exitPath = $"{path}.exits[{i}]";
            ValidateId(exit.Target, exitPath + ".target");
            if (!sceneIds.Contains(exit.Target)) Invalid(exitPath + ".target", "must reference a scene");
            if (!exitTargets.Add(exit.Target)) Invalid(exitPath + ".target", "must be unique in the scene");
            if (exit.Seconds is < 0 or > 86_400) Invalid(exitPath + ".seconds", "must be between 0 and 86400");
            ValidateCondition(exit.When, exitPath + ".when", sceneIds);
        }

        var actions = RequireArray(scene.Actions, path + ".actions");
        if (actions.Length > 80) Invalid(path + ".actions", "must contain at most 80 entries");
        var actionPairs = new HashSet<(string Kind, string Target)>();
        for (var i = 0; i < actions.Length; i++)
        {
            var action = actions[i];
            var actionPath = $"{path}.actions[{i}]";
            ValidateId(action.Id, actionPath + ".id");
            if (!actionIds.Add(action.Id)) Invalid(actionPath + ".id", "must be globally unique");
            ValidateActionKind(action.Kind, actionPath + ".kind");
            ValidatePlainText(action.Target, 80, actionPath + ".target", required: false);
            ValidateRequiredOneLine(action.Label, 160, actionPath + ".label");
            if (!actionPairs.Add((action.Kind, action.Target)))
                Invalid(actionPath, "kind and target pair must be unique in the scene");
            ValidateCondition(action.When, actionPath + ".when", sceneIds);
            if (action.Check is not null) ValidateCheck(action.Check, actionPath + ".check");
            ValidateOutcome(action.Success, actionPath + ".success", sceneIds, itemIds);
            ValidateOutcome(action.Failure, actionPath + ".failure", sceneIds, itemIds);
            ValidateEffects(action.Always, actionPath + ".always", itemIds);
        }

        var variants = RequireArray(scene.Variants, path + ".variants");
        for (var i = 0; i < variants.Length; i++)
        {
            var variant = variants[i];
            var variantPath = $"{path}.variants[{i}]";
            ValidateCondition(variant.When, variantPath + ".when", sceneIds);
            ValidateRequiredOneLine(variant.Title, 160, variantPath + ".title");
            ValidateText(variant.Summary, MaxLongText, variantPath + ".summary");
            ValidateText(variant.ImagePrompt, MaxPrompt, variantPath + ".imagePrompt");
        }

        if (scene.Encounter is not null)
            ValidateEncounter(scene.Encounter, path + ".encounter", sceneIds, itemIds, encounterIds, enemyIds);
    }

    private static void ValidateActionKind(string? kind, string path)
    {
        ValidatePlainText(kind, 47, path, required: true);
        if (kind is "talk" or "investigate") return;

        var dot = kind.IndexOf('.');
        if (dot < 0 || kind.LastIndexOf('.') != dot || kind[..dot] is not ("story" or "script"))
            Invalid(path, "must be talk, investigate, story.*, or script.*");
        var suffix = kind[(dot + 1)..];
        if (suffix.Length is < 1 or > 40 || !IsLowerAsciiLetter(suffix[0]) ||
            suffix.Skip(1).Any(c => !IsLowerAsciiLetter(c) && !char.IsAsciiDigit(c) && c != '_'))
            Invalid(path, "has an invalid action name");
    }

    private static void ValidateCheck(ContentCheck check, string path)
    {
        ValidatePlainText(check.Ability, 20, path + ".ability", required: true);
        if (check.Ability is not ("strength" or "dexterity" or "constitution" or "intelligence" or "wisdom" or "charisma"))
            Invalid(path + ".ability", "must be a supported ability");

        ValidatePlainText(check.Skill, 20, path + ".skill", required: false);
        if (check.Skill.Length != 0 && check.Skill is not ("Acrobatics" or "Animal Handling" or "Arcana" or
            "Athletics" or "Deception" or "History" or "Insight" or "Intimidation" or "Investigation" or
            "Medicine" or "Nature" or "Perception" or "Performance" or "Persuasion" or "Religion" or
            "Sleight of Hand" or "Stealth" or "Survival"))
            Invalid(path + ".skill", "must be empty or a supported skill");
        if (check.Dc is < 1 or > 40) Invalid(path + ".dc", "must be between 1 and 40");
    }

    private static void ValidateOutcome(ContentOutcome? outcome, string path, HashSet<string> sceneIds,
        HashSet<string> itemIds)
    {
        ValidateNotNull(outcome, path);
        ValidateText(outcome.Text, MaxLongText, path + ".text");
        ValidateEffects(outcome.Effects, path + ".effects", itemIds);
    }

    private static void ValidateEffects(ContentEffect[]? effects, string path, HashSet<string> itemIds)
    {
        effects = RequireArray(effects, path);
        if (effects.Length > 64) Invalid(path, "must contain at most 64 entries");
        for (var i = 0; i < effects.Length; i++)
        {
            var effect = effects[i];
            var effectPath = $"{path}[{i}]";
            ValidatePlainText(effect.Op, 20, effectPath + ".op", required: true);
            ValidateNotNull(effect.Key, effectPath + ".key");
            switch (effect.Op)
            {
                case "fact":
                case "removeFact":
                    ValidatePlainText(effect.Key, 128, effectPath + ".key", required: true);
                    if (effect.Amount != 0) Invalid(effectPath + ".amount", "must be 0 for fact effects");
                    break;
                case "item":
                    ValidateId(effect.Key, effectPath + ".key");
                    if (!itemIds.Contains(effect.Key) && !IsKnownItem(effect.Key))
                        Invalid(effectPath + ".key", "must reference a declared or supported item");
                    if (effect.Amount is < -10_000 or > 10_000 || effect.Amount == 0)
                        Invalid(effectPath + ".amount", "must be nonzero and between -10000 and 10000");
                    break;
                case "chapter":
                    if (effect.Key.Length != 0) Invalid(effectPath + ".key", "must be empty for chapter effects");
                    if (effect.Amount is < 1 or > 10_000)
                        Invalid(effectPath + ".amount", "must be between 1 and 10000");
                    break;
                default:
                    Invalid(effectPath + ".op", "must be fact, removeFact, item, or chapter");
                    break;
            }
        }
    }

    private static bool IsKnownItem(string id) => id is "gold-piece" or "greatsword" or "quarterstaff" or
        "dagger" or "chain-mail" or "robe" or "spellbook" or "scholars-pack" or "backpack";

    private static void ValidateCondition(ContentCondition? condition, string path, HashSet<string> sceneIds)
    {
        ValidateNotNull(condition, path);
        ValidateConditionTerms(condition.All, path + ".all", sceneIds);
        ValidateConditionTerms(condition.Any, path + ".any", sceneIds);
        ValidateConditionTerms(condition.None, path + ".none", sceneIds);
    }

    private static void ValidateConditionTerms(string[]? terms, string path, HashSet<string> sceneIds)
    {
        terms = RequireArray(terms, path);
        if (terms.Length > 100) Invalid(path, "must contain at most 100 entries");
        for (var i = 0; i < terms.Length; i++)
        {
            var termPath = $"{path}[{i}]";
            ValidatePlainText(terms[i], 128, termPath, required: true);
            if (terms[i].StartsWith("visited:", StringComparison.Ordinal))
            {
                var sceneId = terms[i]["visited:".Length..];
                if (!sceneIds.Contains(sceneId)) Invalid(termPath, "must reference a scene after visited:");
            }
        }
    }

    private static void ValidateQuest(ContentQuest quest, string path, HashSet<string> sceneIds)
    {
        ValidateRequiredOneLine(quest.Title, 160, path + ".title");
        ValidateText(quest.Summary, MaxLongText, path + ".summary");
        ValidateText(quest.Reward, MaxLongText, path + ".reward");
        ValidateCondition(quest.Visible, path + ".visible", sceneIds);
        ValidateCondition(quest.Active, path + ".active", sceneIds);
        ValidateCondition(quest.Complete, path + ".complete", sceneIds);
        var objectives = RequireArray(quest.Objectives, path + ".objectives");
        for (var i = 0; i < objectives.Length; i++)
        {
            var objectivePath = $"{path}.objectives[{i}]";
            ValidateText(objectives[i].Text, MaxLongText, objectivePath + ".text");
            ValidateCondition(objectives[i].Complete, objectivePath + ".complete", sceneIds);
            if (objectives[i].Visible is { } visible)
                ValidateCondition(visible, objectivePath + ".visible", sceneIds);
        }
    }

    private static void ValidateNpc(ContentNpc npc, string path, HashSet<string> sceneIds,
        HashSet<string> factionIds)
    {
        ValidateRequiredOneLine(npc.Name, 120, path + ".name");
        ValidateId(npc.SceneId, path + ".sceneId");
        if (!sceneIds.Contains(npc.SceneId)) Invalid(path + ".sceneId", "must reference a scene");
        ValidateText(npc.Summary, MaxLongText, path + ".summary");
        ValidateNotNull(npc.FactionId, path + ".factionId");
        if (npc.FactionId.Length != 0)
        {
            ValidateId(npc.FactionId, path + ".factionId");
            if (!factionIds.Contains(npc.FactionId)) Invalid(path + ".factionId", "must reference a faction");
        }
        ValidateCondition(npc.Visible, path + ".visible", sceneIds);
        ValidateCondition(npc.Met, path + ".met", sceneIds);
        var locations = RequireArray(npc.Locations, path + ".locations");
        for (var i = 0; i < locations.Length; i++)
        {
            var locationPath = $"{path}.locations[{i}]";
            ValidateCondition(locations[i].When, locationPath + ".when", sceneIds);
            ValidateId(locations[i].SceneId, locationPath + ".sceneId");
            if (!sceneIds.Contains(locations[i].SceneId)) Invalid(locationPath + ".sceneId", "must reference a scene");
        }
    }

    private static void ValidateFaction(ContentFaction faction, string path, HashSet<string> sceneIds)
    {
        ValidateRequiredOneLine(faction.Name, 120, path + ".name");
        ValidateCondition(faction.Visible, path + ".visible", sceneIds);
        var adjustments = RequireArray(faction.Adjustments, path + ".adjustments");
        for (var i = 0; i < adjustments.Length; i++)
        {
            var adjustmentPath = $"{path}.adjustments[{i}]";
            ValidateCondition(adjustments[i].When, adjustmentPath + ".when", sceneIds);
            if (adjustments[i].Amount is < -10_000 or > 10_000)
                Invalid(adjustmentPath + ".amount", "must be between -10000 and 10000");
        }
    }

    private static void ValidateEncounter(ContentEncounter encounter, string path, HashSet<string> sceneIds,
        HashSet<string> itemIds, HashSet<string> encounterIds, HashSet<string> enemyIds)
    {
        ValidateId(encounter.Id, path + ".id");
        if (!encounterIds.Add(encounter.Id)) Invalid(path + ".id", "must be globally unique");
        ValidateRequiredOneLine(encounter.Title, 160, path + ".title");
        ValidateRequiredOneLine(encounter.StartLabel, 160, path + ".startLabel");
        ValidateCondition(encounter.When, path + ".when", sceneIds);
        if (encounter.Mode is not (null or StandardCombatEngine.Mode)) Invalid(path + ".mode", "unsupported combat mode");
        bool standard = encounter.Mode == StandardCombatEngine.Mode;
        if (encounter.Nonlethal == standard) Invalid(path + ".nonlethal", standard ? "standard-2024 must explicitly be false" : "legacy encounters must be true");

        var enemies = RequireArray(encounter.Enemies, path + ".enemies");
        if (enemies.Length is < 1 or > 3) Invalid(path + ".enemies", "must contain 1 to 3 entries");
        var positions = new HashSet<(int X, int Y)>();
        for (var i = 0; i < enemies.Length; i++)
        {
            var enemy = enemies[i];
            var enemyPath = $"{path}.enemies[{i}]";
            ValidateId(enemy.Id, enemyPath + ".id");
            if (enemy.Id == "player" || Guid.TryParse(enemy.Id, out _))
                Invalid(enemyPath + ".id", "must be a non-player content id");
            if (!enemyIds.Add(enemy.Id)) Invalid(enemyPath + ".id", "must be globally unique");
            ValidateRequiredOneLine(enemy.Name, 120, enemyPath + ".name");
            if (enemy.Tactic is not null && (!standard || enemy.Tactic is not ("engage" or "withdraw") && !(enemy.Tactic == "ranged" && StandardMonsters.IsGoblinWarrior(enemy))))
                Invalid(enemyPath + ".tactic", "standard-2024 supports engage/withdraw; ranged requires exact Goblin Warrior");
            if (enemy.RulesId is not null && (!standard || !StandardMonsters.Matches(enemy)))
                Invalid(enemyPath + ".rulesId", "requires a complete supported XMM profile with matching base statistics and no savingThrows override");
            if (enemy.SavingThrows is { } saves && (!standard || saves.Count != 6 ||
                !new[] { "strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma" }.All(saves.ContainsKey) || saves.Values.Any(n => n is < -5 or > 20)))
                Invalid(enemyPath + ".savingThrows", "requires all six explicit ability saving throw modifiers in standard mode");
            ValidateGridPosition(enemy.X, enemy.Y, enemyPath);
            if (enemy.X == 1 && enemy.Y is >= 1 and <= 4)
                Invalid(enemyPath, "must not use a party spawn position");
            if (!positions.Add((enemy.X, enemy.Y))) Invalid(enemyPath, "position must be unique");
            if (enemy.HitPoints is < 1 or > 500) Invalid(enemyPath + ".hitPoints", "must be between 1 and 500");
            if (enemy.ArmorClass is < 1 or > 30) Invalid(enemyPath + ".armorClass", "must be between 1 and 30");
            if (enemy.Speed is < 5 or > 60 || enemy.Speed % 5 != 0)
                Invalid(enemyPath + ".speed", "must be a multiple of 5 between 5 and 60");
            if (enemy.InitiativeModifier is < -5 or > 20)
                Invalid(enemyPath + ".initiativeModifier", "must be between -5 and 20");
            if (enemy.AttackBonus is < -5 or > 20)
                Invalid(enemyPath + ".attackBonus", "must be between -5 and 20");
            if (enemy.DamageDice is < 1 or > 4) Invalid(enemyPath + ".damageDice", "must be between 1 and 4");
            if (enemy.DamageDie is not (4 or 6 or 8 or 10 or 12))
                Invalid(enemyPath + ".damageDie", "must be 4, 6, 8, 10, or 12");
            if (enemy.DamageBonus is < 0 or > 20) Invalid(enemyPath + ".damageBonus", "must be between 0 and 20");
        }

        var cells = RequireArray(encounter.Cells, path + ".cells");
        if (cells.Length > 35) Invalid(path + ".cells", "must contain at most 35 entries");
        var cellPositions = new HashSet<(int X, int Y)>();
        for (var i = 0; i < cells.Length; i++)
        {
            var cell = cells[i];
            var cellPath = $"{path}.cells[{i}]";
            ValidateGridPosition(cell.X, cell.Y, cellPath);
            if (!cellPositions.Add((cell.X, cell.Y))) Invalid(cellPath, "coordinates must be unique");
            ValidateNotNull(cell.Terrain, cellPath + ".terrain");
            if (cell.Terrain is not ("blocked" or "difficult") && !(standard && cell.Terrain is "half-cover" or "three-quarters-cover"))
                Invalid(cellPath + ".terrain", "unsupported terrain for this combat mode");
            if (cell.Terrain is "blocked" or "half-cover" or "three-quarters-cover")
            {
                if (positions.Contains((cell.X, cell.Y))) Invalid(cellPath, "blocked cell must not contain an enemy spawn");
                if (cell.X == 1 && cell.Y is >= 1 and <= 4)
                    Invalid(cellPath, "blocked cell must not contain a party spawn");
            }
        }

        ValidateEffects(encounter.OnStart, path + ".onStart", itemIds);
        ValidateOutcome(encounter.Victory, path + ".victory", sceneIds, itemIds);
    }

    private static void ValidateGridPosition(int x, int y, string path)
    {
        if (x is < 0 or > 6) Invalid(path + ".x", "must be between 0 and 6");
        if (y is < 0 or > 4) Invalid(path + ".y", "must be between 0 and 4");
    }

    private static T[] RequireArray<T>(T[]? array, string path) where T : class
    {
        ValidateNotNull(array, path);
        for (var i = 0; i < array.Length; i++)
            if (array[i] is null) Invalid($"{path}[{i}]", "is required");
        return array;
    }

    private static void ValidateId([NotNull] string? value, string path)
    {
        ValidateNotNull(value, path);
        if (value.Length is < 1 or > 64 || !IsAsciiLetterOrDigit(value[0]) ||
            value.Skip(1).Any(c => !IsAsciiLetterOrDigit(c) && c is not ('.' or '_' or '-')))
            Invalid(path, "must match ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$");
    }

    private static bool IsAsciiLetterOrDigit(char value) =>
        IsLowerAsciiLetter(value) || value is >= 'A' and <= 'Z' || char.IsAsciiDigit(value);

    private static bool IsLowerAsciiLetter(char value) => value is >= 'a' and <= 'z';

    private static void ValidateRequiredOneLine(string? value, int maxLength, string path) =>
        ValidatePlainText(value, maxLength, path, required: true);

    private static void ValidateOneLine(string? value, int maxLength, string path) =>
        ValidatePlainText(value, maxLength, path, required: false);

    private static void ValidatePlainText([NotNull] string? value, int maxLength, string path, bool required)
    {
        ValidateNotNull(value, path);
        if (required && value.Length == 0) Invalid(path, "must not be empty");
        if (value.Length > maxLength) Invalid(path, $"must be at most {maxLength} characters");
        if (value.Any(char.IsControl)) Invalid(path, "must not contain control characters");
    }

    private static void ValidateText([NotNull] string? value, int maxLength, string path)
    {
        ValidateNotNull(value, path);
        if (value.Length > maxLength) Invalid(path, $"must be at most {maxLength} characters");
    }

    private static void ValidateNotNull<T>([NotNull] T? value, string path) where T : class
    {
        if (value is null) Invalid(path, "is required");
    }

    [DoesNotReturn]
    private static void Invalid(string path, string message) =>
        throw new GameException("invalid_content", $"{path}: {message}", 400);
}
