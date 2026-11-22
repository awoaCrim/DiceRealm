namespace DiceRealm.Server.Domain;

// A missing persisted review is a legacy permission, never evidence of a human review.
public sealed record CharacterReview(int Revision, string Status, string Submission = "", string Reason = "",
    string ReviewedBy = "", DateTimeOffset? ReviewedAt = null, string Source = "submission");
public sealed record ReviewCharacterRequest(string RequestId, int ExpectedVersion, string ActorId, int Revision,
    string Decision, string Reason = "");
public sealed record ResubmitCharacterRequest(string RequestId, int ExpectedVersion, int Revision, string Submission,
    string CharacterName = "", string TemplateId = "", CharacterCreationChoices? Creation = null, CharacterBuild? Build = null);

public static class CharacterReviews
{
    public static CharacterReview View(CharacterReview? review) => review ?? new(0, "approved", Source: "legacy");
    public static bool Approved(CharacterReview? review) => review is null || review.Status == "approved";
    public static bool CanAct(Campaign c) => PartyEngine.HasCharacter(c) && Approved(PartyEngine.IsHost(c) ? c.HostReview : c.PartyMembers.Single(m => m.Id == c.ActingActorId).Review);
    public static void RequireApproved(Campaign c)
    {
        PartyEngine.RequireCharacter(c);
        if (!CanAct(c)) throw new GameException("character_review_required", "角色尚未通过 DM 审核。请阅读审核意见，退回后可补充说明并重新提交。", 403);
    }
    public static Resolution Review(Campaign c, ReviewCharacterRequest request)
    {
        PartyEngine.RequireHost(c);
        if (request.Decision is not ("approve" or "return") || request.Revision < 1)
            throw new GameException("invalid_character_review", "请选择批准或退回，并提供当前角色修订号。");
        string reason = Note(request.Reason, request.Decision == "return");
        var seat = c.PartyMembers.FirstOrDefault(m => m.Id == request.ActorId && !m.Revoked)
            ?? throw new GameException("invalid_seat", "此角色席位不存在或已撤销。", 409);
        if (seat.Review is not { Status: "pending" } review || review.Revision != request.Revision)
            throw new GameException("character_review_changed", "角色提交已变化或已审核，请读取当前资料。", 409);
        if (request.Decision == "approve" && (!PartyEngine.CanAdmitCharacter(c) || c.PendingRolls.Any(r => r.Status == "pending")))
            throw new GameException("party_unavailable", "战斗中、有人倒地或有待投掷时不能批准，结束后再批准。", 409);
        string status = request.Decision == "approve" ? "approved" : "returned";
        seat.Review = review with { Status = status, Reason = reason, ReviewedBy = c.ActingActorId, ReviewedAt = DateTimeOffset.UtcNow, Source = "dm_review" };
        return new("resolved", "character.review", seat.Character.Name + (status == "approved" ? " 的角色已获 DM 批准，可以参与冒险。" + (reason.Length > 0 ? "审核意见：" + reason : "") : " 的角色已退回：" + reason), null,
            ["actor:" + seat.Id, "review:" + status, "revision:" + review.Revision]);
    }
    public static Resolution Resubmit(Campaign c, ResubmitCharacterRequest request)
    {
        if (PartyEngine.IsHost(c)) throw new GameException("character_review_unavailable", "主持自建角色无需使用队员重交入口。", 409);
        var seat = c.PartyMembers.Single(m => m.Id == c.ActingActorId);
        if (seat.Review is not { Status: "returned" } review || review.Revision != request.Revision)
            throw new GameException("character_review_changed", "只有当前被退回的角色可以重交；已批准角色不能重建或重置资源。", 409);
        string submission = Note(request.Submission, true);
        if (request.CharacterName is null || request.TemplateId is null)
            throw new GameException("invalid_character_review", "角色修订字段不能为 null。");
        bool replacing = request.CharacterName.Length != 0 || request.TemplateId.Length != 0 || request.Creation is not null || request.Build is not null;
        if (replacing)
        {
            if (string.IsNullOrWhiteSpace(request.CharacterName) || request.CharacterName.Length > 40 || request.CharacterName.Any(char.IsControl))
                throw new GameException("invalid_character_review", "重新建卡需要完整角色名与完整构筑。");
            // Only a never-approved character can be replaced. Keep identity and seat credentials.
            var replacement = CharacterEngine.CreateComplete(request.CharacterName.Trim(), request.TemplateId, request.Creation, request.Build);
            seat.Character = replacement with { Id = seat.Character.Id };
        }
        seat.Review = new(review.Revision + 1, "pending", submission);
        return new("resolved", "character.resubmit", seat.Character.Name + " 已重新提交角色审核。提交说明：" + submission + "。审核前可阅读冒险，不能执行行动。", null,
            ["actor:" + seat.Id, "review:pending", "revision:" + seat.Review.Revision]);
    }
    private static string Note(string? value, bool required)
    {
        if (value is null || value.Length > 1000 || value.Any(c => char.IsControl(c) && c is not ('\r' or '\n' or '\t')) || required && string.IsNullOrWhiteSpace(value))
            throw new GameException("invalid_character_review", "请提供不超过 1000 字的审核理由或提交说明。");
        return value.Trim();
    }
}
