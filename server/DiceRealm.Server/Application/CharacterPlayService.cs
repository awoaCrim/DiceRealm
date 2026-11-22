using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    public Task<CharacterSheetView> CharacterSheet(string id,string token,CancellationToken ct) =>
        store.Access(id, token, false, c =>
        {
            var sheet = CharacterRuleDetails.Enrich(CharacterPlayEngine.View(c), localRules, c.Adventure?.Items);
            return Task.FromResult(sheet with { Character = ProjectPortrait(c, c.ActingActorId, sheet.Character) });
        }, ct);
    public Task<CharacterRuleReferences> CharacterReferences(string id, string token, string actorId, CancellationToken ct) =>
        store.Access(id, token, false, c =>
        {
            var character = actorId == PartyEngine.HostId ? c.Character
                : c.PartyMembers.FirstOrDefault(member => member.Id == actorId && !member.Revoked)?.Character;
            if (character is null) throw new GameException("character_unavailable", "该角色资料当前不可用。", 404);
            return Task.FromResult(CharacterRuleDetails.References(c.Version, actorId, character, localRules));
        }, ct);
    public Task<AdjustmentPreview> PreviewAdjustment(string id,string token,AdjustCharacterRequest request,CancellationToken ct)
    {
        RequestId(request.RequestId);
        return store.Access(id,token,false,c=>Task.FromResult(CharacterAdjustments.Preview(c,request)),ct);
    }
    public Task<ActionResponse> AdjustCharacter(string id,string token,AdjustCharacterRequest request,CancellationToken ct) =>
        HostCommand(id,token,request.RequestId,request.ExpectedVersion,"character.adjust",request,c=>CharacterAdjustments.Apply(c,request),ct);
    public Task<ActionResponse> PlayCharacter(string id,string token,CharacterPlayRequest request,CancellationToken ct)
    {
        RequestId(request.RequestId);
        if(request.ExpectedVersion<1)throw new GameException("invalid_input","需要 expectedVersion。");
        return store.Access(id,token,true,c=>
        {
            var fingerprint=JsonFiles.Hash("character.command:"+JsonSerializer.Serialize(request,JsonFiles.Options));
            var receipt=store.FindReceipt(c,request.RequestId);
            if(receipt is not null)
            {
                if(receipt.Fingerprint!=fingerprint)throw new GameException("idempotency_conflict","请求 ID 已用于另一份请求。",409);
                return Task.FromResult(new ActionResponse(Snapshot(c),receipt.Resolution,true));
            }
            if(c.Version!=request.ExpectedVersion)throw new GameException("stale_version","状态已更新，请刷新角色操作。",409);
            RequireActive(c);
        CharacterReviews.RequireApproved(c);
        GameLifecycle.RequireAction(c);
            ContextualRolls.RequireNoPending(c);
            var resolution=ExecuteCharacterAction(c,request);
            c.Receipts.Add(new(request.RequestId,fingerprint,resolution,c.ActingActorId));
            return Task.FromResult(new ActionResponse(Snapshot(c),resolution,false));
        },ct);
    }

    private Resolution ExecuteCharacterAction(Campaign c, CharacterPlayRequest request, string input = "", string intentId = "", string label = "")
    {
        var before = ActivityRecords.Capture(c); var scene = Adventure.Current(c); var name = c.ActingCharacter.Name; long originTime = c.ElapsedSeconds;
        if (label == "" && request.Operation == "unpack")
            label = "拆开 " + (c.ActingCharacter.Inventory.FirstOrDefault(i => "unpack:" + i.Id == request.Key)?.Name ?? "套装");
        if (label == "" && request.Operation == "loadout")
            label = EquipmentLoadout.View(c.ActingCharacter).Options.FirstOrDefault(o => o.Key == request.Key)?.Label ?? "更换装备";
        if (label == "" && request.Operation is "wear" or "attunement")
        {
            var wearables = WearableEquipment.View(c, intentId);
            label = (request.Operation == "wear" ? wearables.Options : wearables.AttunementOptions).FirstOrDefault(o => o.Key == request.Key)?.Label ?? request.Operation;
        }
        var resolution = characterPlay.Resolve(c, request, intentId) with { IntentId = intentId };
        c.Version++;
        if (intentId.Length == 0 && resolution.Status == "resolved" && resolution.RulingId.Length == 0 &&
            request.Operation is "equip" or "loadout" or "wear" or "unpack")
        {
            // Current equipment/inventory is authoritative; this is not a story entry.
            // The caller still commits the exact request receipt atomically with state.
            c.StateOnlyVersions.Add(c.Version);
            return resolution;
        }
        ActivityRecords.Link(c, resolution);
        var intent = c.PendingIntents.FirstOrDefault(i => i.Id == intentId);
        var origin = new ActionOrigin(input, label == "" ? request.Operation + (request.Key == "" ? "" : " · " + request.Key) : label,
            "character." + request.Operation, request.Key, name, scene.Id, scene.Title, ActivityRecords.Changes(before, c), originTime, c.ElapsedSeconds,
            intent?.Clarifications.ToArray());
        c.Events.Add(new(Guid.NewGuid().ToString(), c.Version, resolution.Kind, resolution.Summary, "", "system", DateTimeOffset.UtcNow,
            resolution, c.ActingActorId, Origin: origin));
        ActionUnderstanding.Complete(c, resolution, origin);
        return resolution;
    }
}
