using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class CharacterTests
{
    private static Campaign Wizard()
    {
        // Content-activated so the causeway patrol and scene routes are available to the engine.
        var campaign = TestContent.Campaign("harbor", "Wizard");
        campaign.Character = CharacterEngine.Create("Mira", CharacterEngine.Wizard);
        return campaign;
    }
    private static bool Choice(Campaign c, string kind, string target = "") => Adventure.Choices(c).Any(a => a.Kind == kind && a.Target == target);
    private static CombatUnit P(Campaign c) => c.Combat!.Units.Single(u => u.Id == "player");
    private static CombatUnit E(Campaign c) => c.Combat!.Units.Single(u => u.Id == "guardian");
    private sealed class MinimumDice : IDice { public int Count; public int Roll(int sides) { Count++; return 1; } }
    private sealed class ForbiddenText : IIntentInterpreter, INarrator
    {
        public int Calls;
        public Task<Intent?> Interpret(string text, ActionChoice[] allowed, CancellationToken ct, string campaignId = "", PromptBundle? prompts = null) { Calls++; throw new Exception("Unexpected interpreter"); }
        public Task<Narrative> Narrate(NarrativeContext context, CancellationToken ct, string campaignId = "", PromptBundle? prompts = null) { Calls++; throw new Exception("Unexpected narrator"); }
    }
    public static Task TemplateAndEquipment()
    {
        var c = Wizard(); var pc = c.Character.Required();
        Check.Equal(9, pc.MaxHitPoints); Check.Equal(11, pc.ArmorClass); Check.Equal(55, pc.Inventory.Single(i => i.Id == "gold-piece").Quantity);
        Check.True(pc.Abilities.Select(a => a.Score).SequenceEqual(new[] { 9, 13, 16, 15, 12, 10 }));
        Check.Equal(4, pc.Spellcasting!.AttackBonus); Check.Equal(12, pc.Spellcasting.SaveDc);
        Check.Equal(3, pc.Spellcasting.Spells.Count(s => s.Level == 0)); Check.Equal(6, pc.Spellcasting.Spells.Count(s => s.Level > 0));
        Check.Equal(4, pc.Spellcasting.Spells.Count(s => s.Level > 0 && s.Prepared));
        Check.Throws<GameException>(() => CharacterEngine.Create("Bad", "wizard999"));
        var dice = new SequenceDice(10, 1, 1); var combat = new CombatEngine(dice);
        var staff = combat.WeaponAttack(pc, 10);
        Check.Equal(1, staff.Modifier); Check.Equal(-1, staff.DamageModifier); Check.Equal(0, staff.Damage); // no GWF on Wizard
        Check.Equal(1, staff.DamageRolls.Length); Check.Equal(1, staff.AlternateRolls.Length);
        var chars = new CharacterEngine(new MinimumDice()); chars.Resolve(c, "equipment.equip", "dagger");
        Check.Equal("dagger", CharacterEngine.Weapon(c.Character.Required())!.Id);
        // Preparing another weapon preserves carried equipment; the active weapon above changes independently.
        Check.True(c.Character.Inventory.Single(i => i.Id == "quarterstaff").Equipped);
        var dagger = new CombatEngine(new SequenceDice(10, 1, 4)).WeaponAttack(c.Character, 10);
        Check.Equal(3, dagger.Modifier); Check.Equal(5, dagger.Damage); Check.Equal(1, dagger.DamageModifier);
        Check.Throws<GameException>(() => chars.Resolve(c, "equipment.equip", "greatsword"));
        Check.Throws<GameException>(() => chars.Resolve(c, "equipment.armor", "don"));
        c.Character = StarterCharacter.Create("Tank");
        chars.Resolve(c, "equipment.armor", "doff"); Check.Equal(11, c.Character.ArmorClass); Check.Equal(5, c.ElapsedMinutes);
        chars.Resolve(c, "equipment.armor", "don"); Check.Equal(16, c.Character.ArmorClass); Check.Equal(15, c.ElapsedMinutes);
        return Task.CompletedTask;
    }
    public static Task SpellCombat()
    {
        var c = Wizard(); c.SceneId = "causeway";
        var dice = new SequenceDice(20, 1, 20, 7, 8); var combat = new CombatEngine(dice);
        combat.Resolve(c, "combat.start", "");
        Check.True(Choice(c, "combat.cast", "fire-bolt:guardian"));
        var fire = combat.Resolve(c, "combat.cast", "fire-bolt:guardian");
        var hit = fire.CombatLog!.Single(e => e.Spell?.SpellId == "fire-bolt");
        Check.True(hit.Attack!.Critical); Check.Equal(15, hit.Attack.Damage); Check.Equal(0, hit.Attack.DamageModifier);
        Check.Equal(0, hit.Attack.AlternateRolls.Length); Check.Equal(3, E(c).HitPoints); Check.Equal(5, dice.Count);
        Check.Equal(2, CharacterEngine.Value(c.Character.Required(), "Spell Slots (1st)"));
        Check.Throws<GameException>(() => combat.Resolve(c, "combat.cast", "magic-missile:guardian"));
        Check.Throws<GameException>(() => combat.Resolve(c, "equipment.equip", "dagger"));
        var close = Wizard(); close.SceneId = "causeway";
        dice = new SequenceDice(20, 1, 20, 1); combat = new(dice); combat.Resolve(close, "combat.start", "");
        E(close).X = 2; E(close).Y = 2;
        var miss = combat.Resolve(close, "combat.cast", "fire-bolt:guardian").CombatLog!.Single(e => e.Spell != null);
        Check.Equal("disadvantage", miss.Attack!.Mode); Check.Equal(1, miss.Attack.Selected); Check.Equal(0, miss.Spell!.Damage);
        Check.True(!P(close).SavageAttackerUsed);
        var missile = Wizard(); missile.SceneId = "causeway";
        dice = new SequenceDice(20, 1, 1, 2, 4); combat = new(dice); combat.Resolve(missile, "combat.start", "");
        var result = combat.Resolve(missile, "combat.cast", "magic-missile:guardian");
        var magic = result.CombatLog!.Single(e => e.Spell?.SpellId == "magic-missile");
        Check.True(magic.Attack is null); Check.True(magic.Spell!.DamageRolls.SequenceEqual(new[] { 1, 2, 4 }));
        Check.Equal(10, magic.Spell.Damage); Check.Equal(8, E(missile).HitPoints); Check.Equal(5, dice.Count);
        Check.Equal(1, CharacterEngine.Value(missile.Character.Required(), "Spell Slots (1st)"));
        Check.Throws<GameException>(() => combat.Resolve(missile, "combat.cast", "shield:self"));
        Check.Throws<GameException>(() => combat.Resolve(missile, "combat.cast", "magic-missile:self"));
        var armor = Wizard(); armor.SceneId = "causeway"; combat = new(new MinimumDice()); combat.Resolve(armor, "combat.start", "");
        combat.Resolve(armor, "combat.cast", "mage-armor:self");
        Check.Equal(14, P(armor).ArmorClass); Check.Equal(14, armor.Character.Required().ArmorClass); Check.True(!P(armor).ActionAvailable);
        Check.True(!Choice(armor, "rest.long")); Check.Equal(1, CharacterEngine.Value(armor.Character, "Spell Slots (1st)"));
        return Task.CompletedTask;
    }
    public static Task RecoveryAndClock()
    {
        var c = Wizard(); var dice = new SequenceDice(6); var chars = new CharacterEngine(dice);
        chars.Resolve(c, "character.cast", "mage-armor:self"); Check.Equal(14, c.Character.Required().ArmorClass);
        Check.Equal(28800L, c.Character.Effects!.Single().ExpiresAtSeconds);
        Check.True(!Choice(c, "character.cast", "mage-armor:self"));
        c.Character = c.Character with { HitPoints = 1 };
        chars.Resolve(c, "rest.short", "hit_die_arcane");
        Check.Equal(9, c.Character.HitPoints); Check.Equal(2, CharacterEngine.Value(c.Character, "Spell Slots (1st)"));
        Check.Equal(0, CharacterEngine.Value(c.Character, "Arcane Recovery")); Check.Equal(0, CharacterEngine.Value(c.Character, "Hit Dice (d6)"));
        Check.Equal(60, c.ElapsedMinutes); Check.Equal(14, c.Character.ArmorClass); Check.Equal(1, dice.Count);
        CharacterEngine.Change(c, "Spell Slots (1st)", -2);
        Check.True(!Choice(c, "rest.short", "arcane"));
        chars.Resolve(c, "rest.long", "");
        Check.Equal(11, c.Character.ArmorClass); Check.Equal(0, c.Character.Effects!.Length);
        Check.Equal(1, CharacterEngine.Value(c.Character, "Hit Dice (d6)")); Check.Equal(1, CharacterEngine.Value(c.Character, "Arcane Recovery"));
        Check.Equal(1, CharacterEngine.Value(c.Character, "Heroic Inspiration")); Check.Equal(2, CharacterEngine.Value(c.Character, "Spell Slots (1st)"));
        Check.Equal(540, c.ElapsedMinutes); Check.Equal(90000L, c.Character.NextLongRestAtSeconds);
        Check.Throws<GameException>(() => chars.Resolve(c, "rest.long", ""));
        c.Character = c.Character with { HitPoints = 2 }; chars.Resolve(c, "rest.wait", "");
        Check.Equal(2, c.Character.HitPoints); Check.Equal(1500, c.ElapsedMinutes); Check.True(PartyRest.View(c).Options.Single(o => o.Kind == "long").Available);
        chars.Resolve(c, "rest.long", ""); Check.Equal(9, c.Character.HitPoints); Check.Equal(1980, c.ElapsedMinutes);
        var missing = Wizard(); missing.Character = missing.Character.Required() with { Inventory = missing.Character.Required().Inventory.Where(i => i.Id is not ("quarterstaff" or "spellbook")).ToArray() };
        Check.True(!CharacterEngine.CanCast(missing, "mage-armor")); Check.True(CharacterEngine.CanCast(missing, "fire-bolt"));
        var armored = Wizard(); CharacterEngine.MageArmor(armored); armored.Character = armored.Character.Required() with { Inventory = [..armored.Character.Required().Inventory, new("chain-mail", "Chain Mail", 1, true)] };
        CharacterEngine.Sync(armored); Check.Equal(0, armored.Character.Effects!.Length); Check.True(!CharacterEngine.CanCast(armored, "fire-bolt"));
        return Task.CompletedTask;
    }
    public static async Task HttpDurability()
    {
        var dice = new MinimumDice(); var text = new ForbiddenText();
        var host = await Host.Start(dice: dice, interpreter: text, narrator: text);
        var create = await host.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Caster", "Mira", CharacterEngine.Fighter, TestContent.Document, TestContent.Prompts, StartImmediately: true, Build: FullCreationTests.Named("Mira", CharacterEngine.Wizard)));
        Check.Equal(HttpStatusCode.Created, create.StatusCode); var created = (await create.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", created.AccessToken); var s = created.Snapshot;
        var bad = await host.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Bad", "Mira", "unknown", TestContent.Document, TestContent.Prompts, StartImmediately: true)); Check.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        var forged = new StringContent(JsonSerializer.Serialize(new { requestId = Guid.NewGuid(), expectedVersion = 1, kind = "character.cast", target = "mage-armor:self", spellSlots = 99 }), Encoding.UTF8, "application/json");
        Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsync($"/api/v1/campaigns/{s.Id}/actions", forged)).StatusCode);
        var request = new ActionRequest(Guid.NewGuid().ToString(), s.Version, "character.cast", "mage-armor:self");
        var responses = await Task.WhenAll(host.Send(s.Id, request), host.Send(s.Id, request));
        Check.True(responses.All(r => r.StatusCode == HttpStatusCode.OK));
        var a = (await responses[0].Content.ReadFromJsonAsync<ActionResponse>())!; var b = (await responses[1].Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(a.Replayed != b.Replayed); s = a.Snapshot;
        Check.Equal(2, s.Version); Check.Equal(14, s.Character.Required().ArmorClass); Check.Equal(1, CharacterEngine.Value(s.Character.Required(), "Spell Slots (1st)"));
        Check.Equal(0, text.Calls); Check.Equal(0, dice.Count);
        Check.Equal(HttpStatusCode.Conflict, (await host.Send(s.Id, new(Guid.NewGuid().ToString(), s.Version, "character.cast", "shield:self"))).StatusCode);
        var path = host.Root; await host.DisposeAsync();
        await using var restarted = await Host.Start(path, dice, interpreter: text, narrator: text);
        restarted.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", created.AccessToken);
        var replay = (await (await restarted.Send(s.Id, request)).Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(replay.Replayed); Check.Equal(1, CharacterEngine.Value(replay.Snapshot.Character.Required(), "Spell Slots (1st)"));
        Check.Equal(s.Character.Effects!.Single().ExpiresAtSeconds, replay.Snapshot.Character.Effects!.Single().ExpiresAtSeconds);
        s = (await restarted.Rest(replay.Snapshot, "short")).Snapshot;
        s = (await restarted.Act(s, "rest.arcane", "arcane")).Snapshot;
        Check.Equal(2, CharacterEngine.Value(s.Character.Required(), "Spell Slots (1st)")); Check.Equal(60, s.ElapsedMinutes);
        Check.Equal(0, text.Calls); Check.Equal(0, dice.Count);
    }
}
