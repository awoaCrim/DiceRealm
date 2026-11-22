namespace DiceRealm.Server.Domain;

// Input-driven preparation: the host supplies their own source text and intent, an external
// model proposes a strictly typed, source-evidenced outline, and the server projects it into an
// AdventureDocument draft. The model never invents mechanical values (dice, DC, HP, rewards,
// facts, coordinates, conditions): travel seconds and safe rest are explicit host choices, and
// scenes without position evidence stay Unlocated.
public sealed record PreparationInput(string SourceText, string Intent, string Name, string AdventureId,
    string AdventureVersion, bool StartSafeRest, int? TravelSeconds);
public sealed record PreparationPrompt(string Id, string Version, string Text);
public sealed record PreparationRequest(string RequestId, PreparationInput Input, PreparationPrompt Prompt, bool ConfirmProviderUse);
public sealed record PreparationInspectRequest(PreparationInput Input, PreparationProposal Proposal);

public sealed record PreparationEvidence(string Field, int Start, int Length, string Quote);
public sealed record PreparationScene(string Id, string Title, string Summary, string Arrival, PreparationEvidence[] Evidence);
public sealed record PreparationRoute(string From, string To, PreparationEvidence[] Evidence);
public sealed record PreparationKnowledge(string Id, string Kind, string Name, string Summary, string SceneId,
    string Visibility, string RevealSceneId, PreparationEvidence[] Evidence);
public sealed record PreparationProposal(string StartSceneId, PreparationScene[] Scenes, PreparationRoute[] Routes,
    PreparationKnowledge[] Knowledge, string[] Questions);

public sealed record PreparationIssue(string Severity, string Path, string Message);
public sealed record PreparationResult(string RequestId, string Status, string InputHash, string PromptHash,
    PreparationProposal? Proposal, AdventureDocument? Document, PreparationIssue[] Issues, string ProviderModel);
public sealed record PreparationInspectResult(string Status, string InputHash, PreparationProposal Proposal,
    AdventureDocument? Document, PreparationIssue[] Issues);
public sealed record PreparationStatus(bool Enabled, string Model, int MaximumSourceCharacters, int MaximumInputBytes, string Notice);
public sealed record PreparationOutcome(string Status, AdventureDocument? Document, PreparationIssue[] Issues);

public static class PreparationLimits
{
    public const int MaximumRequestBytes = 1024 * 1024;
    public const int MaximumSourceCharacters = 200_000;
    public const int MaximumIntentCharacters = 8_000;
    public const int MaximumPromptCharacters = 32_768;
    public const int MaximumOutboundBytes = 128 * 1024;
    public const int MaximumScenes = 40;
    public const int MaximumRoutes = 80;
    public const int MaximumKnowledge = 64;
    public const int MaximumQuestions = 20;
    public const int MaximumEvidence = 8;
    public const int MaximumEvidenceCharacters = 2_000;
    public const int MaximumSceneSummary = 8_000;
    public const int MaximumKnowledgeSummary = 800;
    public const int MaximumKnowledgeName = 80;
    public const int MaximumQuestionCharacters = 1000;
    public const int MaximumName = 120;
    public const int MaximumId = 64;
}

public static class PreparationProjection
{
    public const string ErrorSeverity = "error";
    public const string ClarificationSeverity = "clarification";

    // Shape, size and consent rejections are 4xx before any record or external call exists.
    public static void ValidateRequestShape(PreparationRequest? request)
    {
        if (request is null) throw Invalid("请求不能为空。");
        if (!Guid.TryParseExact(request.RequestId, "D", out _)) throw Invalid("requestId 必须是标准 UUID。");
        if (!request.ConfirmProviderUse)
            throw new GameException("provider_consent_required", "请明确同意把本次原文与意图发送到已配置的文本模型。", 400);
        ValidateInput(request.Input);
        ValidatePrompt(request.Prompt);
    }

    public static void ValidateInput(PreparationInput? input)
    {
        if (input is null) throw Invalid("缺少 input。");
        RequireText(input.SourceText, PreparationLimits.MaximumSourceCharacters, "input.sourceText", required: false, multiline: true);
        RequireText(input.Intent, PreparationLimits.MaximumIntentCharacters, "input.intent", required: false, multiline: true);
        if (string.IsNullOrWhiteSpace(input.SourceText) && string.IsNullOrWhiteSpace(input.Intent)) throw Invalid("请至少提供原文或冒险意图。");
        RequireId(input.AdventureId, "input.adventureId");
        RequireToken(input.AdventureVersion, 80, "input.adventureVersion");
        RequireText(input.Name, PreparationLimits.MaximumName, "input.name", required: true, multiline: false);
        if (input.TravelSeconds is int seconds && seconds is < 0 or > 86_400)
            throw Invalid("input.travelSeconds 必须在 0..86400，或用 null 表示尚未授权。");
    }

    public static void ValidatePrompt(PreparationPrompt? prompt)
    {
        if (prompt is null) throw Invalid("缺少 prompt；系统不会提供任何内置整理提示词。");
        RequireToken(prompt.Id, PreparationLimits.MaximumId, "prompt.id");
        RequireToken(prompt.Version, 32, "prompt.version");
        RequireText(prompt.Text, PreparationLimits.MaximumPromptCharacters, "prompt.text", required: true, multiline: true);
    }

    // Structural/semantic proposal validation. Invalid output is a whole-proposal rejection, not a
    // partial acceptance: unknown references, duplicates, over-limit counts and evidence that does
    // not quote the exact UTF-16 slice are all errors. Extra/mechanical JSON fields are already
    // refused by strict deserialization before this runs.
    public static PreparationIssue[] ValidateProposal(PreparationProposal? proposal, PreparationInput input)
    {
        var issues = new List<PreparationIssue>();
        if (proposal is null)
        {
            issues.Add(new(ErrorSeverity, "proposal", "模型没有返回可用的结构化提议。"));
            return issues.ToArray();
        }
        if (proposal.StartSceneId is null || proposal.Scenes is null || proposal.Routes is null ||
            proposal.Knowledge is null || proposal.Questions is null)
        {
            issues.Add(new(ErrorSeverity, "proposal", "提议缺少必需的结构字段。"));
            return issues.ToArray();
        }
        if (proposal.Scenes.Length > PreparationLimits.MaximumScenes)
            issues.Add(new(ErrorSeverity, "scenes", $"场景数量不能超过 {PreparationLimits.MaximumScenes}。"));
        if (proposal.Routes.Length > PreparationLimits.MaximumRoutes)
            issues.Add(new(ErrorSeverity, "routes", $"路线数量不能超过 {PreparationLimits.MaximumRoutes}。"));
        if (proposal.Knowledge.Length > PreparationLimits.MaximumKnowledge)
            issues.Add(new(ErrorSeverity, "knowledge", $"知识条目不能超过 {PreparationLimits.MaximumKnowledge}。"));
        if (proposal.Questions.Length > PreparationLimits.MaximumQuestions)
            issues.Add(new(ErrorSeverity, "questions", $"问题不能超过 {PreparationLimits.MaximumQuestions}。"));

        var sceneIds = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < proposal.Scenes.Length; i++)
        {
            var scene = proposal.Scenes[i];
            var path = $"scenes[{i}]";
            if (scene is null) { issues.Add(new(ErrorSeverity, path, "场景缺失。")); continue; }
            if (scene.Id is null || !IsId(scene.Id)) issues.Add(new(ErrorSeverity, path + ".id", "场景 ID 不合法。"));
            else if (!sceneIds.Add(scene.Id)) issues.Add(new(ErrorSeverity, path + ".id", "场景 ID 必须唯一。"));
            CheckText(scene.Title, 160, path + ".title", required: true, multiline: false, issues);
            CheckText(scene.Summary, PreparationLimits.MaximumSceneSummary, path + ".summary", required: false, multiline: true, issues);
            CheckText(scene.Arrival, PreparationLimits.MaximumSceneSummary, path + ".arrival", required: false, multiline: true, issues);
            ValidateEvidence(scene.Evidence, input, path, issues);
        }

        if (proposal.StartSceneId is { Length: > 0 } && !sceneIds.Contains(proposal.StartSceneId))
            issues.Add(new(ErrorSeverity, "startSceneId", "起点必须引用已声明的场景，不能默认取第一个。"));

        var routePairs = new HashSet<(string From, string To)>();
        for (var i = 0; i < proposal.Routes.Length; i++)
        {
            var route = proposal.Routes[i];
            var path = $"routes[{i}]";
            if (route is null) { issues.Add(new(ErrorSeverity, path, "路线缺失。")); continue; }
            if (route.From is null || !sceneIds.Contains(route.From)) issues.Add(new(ErrorSeverity, path + ".from", "必须引用已声明的场景。"));
            if (route.To is null || !sceneIds.Contains(route.To)) issues.Add(new(ErrorSeverity, path + ".to", "必须引用已声明的场景。"));
            if (route.From is not null && route.From == route.To) issues.Add(new(ErrorSeverity, path, "路线不能指向自身。"));
            if (route.From is not null && route.To is not null && !routePairs.Add((route.From, route.To)))
                issues.Add(new(ErrorSeverity, path, "同一条路线不能重复。"));
            ValidateEvidence(route.Evidence, input, path, issues);
        }

        var knowledgeIds = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < proposal.Knowledge.Length; i++)
        {
            var entry = proposal.Knowledge[i];
            var path = $"knowledge[{i}]";
            if (entry is null) { issues.Add(new(ErrorSeverity, path, "知识条目缺失。")); continue; }
            if (entry.Id is null || !IsId(entry.Id)) issues.Add(new(ErrorSeverity, path + ".id", "知识 ID 不合法。"));
            else if (!knowledgeIds.Add(entry.Id)) issues.Add(new(ErrorSeverity, path + ".id", "知识 ID 必须唯一。"));
            if (entry.Kind is not ("npc" or "quest" or "place" or "clue"))
                issues.Add(new(ErrorSeverity, path + ".kind", "kind 只能是 npc、quest、place 或 clue。"));
            CheckText(entry.Name, PreparationLimits.MaximumKnowledgeName, path + ".name", required: true, multiline: false, issues);
            CheckText(entry.Summary, PreparationLimits.MaximumKnowledgeSummary, path + ".summary", required: false, multiline: true, issues);
            if (entry.SceneId is null) issues.Add(new(ErrorSeverity, path + ".sceneId", "sceneId 不能为 null；未知位置请留空字符串。"));
            else if (entry.SceneId.Length > 0 && !sceneIds.Contains(entry.SceneId))
                issues.Add(new(ErrorSeverity, path + ".sceneId", "只能引用已声明的场景；未知位置必须留空。"));
            if (entry.Visibility is not ("host" or "public" or "arrival"))
                issues.Add(new(ErrorSeverity, path + ".visibility", "visibility 只能是 host、public 或 arrival。"));
            if (entry.RevealSceneId is null)
                issues.Add(new(ErrorSeverity, path + ".revealSceneId", "revealSceneId 不能为 null。"));
            else if (entry.Visibility == "arrival")
            {
                if (entry.RevealSceneId.Length == 0 || !sceneIds.Contains(entry.RevealSceneId))
                    issues.Add(new(ErrorSeverity, path + ".revealSceneId", "arrival 知识必须引用一个已声明的公开场景。"));
            }
            else if (entry.RevealSceneId.Length != 0)
                issues.Add(new(ErrorSeverity, path + ".revealSceneId", "只有 arrival 知识可以设置 revealSceneId。"));
            ValidateEvidence(entry.Evidence, input, path, issues);
        }

        for (var i = 0; i < proposal.Questions.Length; i++)
            CheckText(proposal.Questions[i], PreparationLimits.MaximumQuestionCharacters, $"questions[{i}]", required: true, multiline: false, issues);

        return issues.ToArray();
    }

    // Produces the ready document, a clarification request, or a failed whole-proposal rejection.
    // A document is only produced when every candidate is source-evidenced, references resolve,
    // and the host has explicitly chosen the blocked rule values.
    public static PreparationOutcome Project(PreparationInput input, PreparationProposal? proposal)
    {
        var issues = ValidateProposal(proposal, input);
        if (proposal is null || issues.Any(i => i.Severity == ErrorSeverity))
            return new("failed", null, issues);
        var clarifications = Clarify(input, proposal);
        if (clarifications.Length > 0) return new("needs_clarification", null, clarifications);
        try
        {
            var document = Build(input, proposal);
            ContentValidator.Validate(document);
            return new("ready", document, []);
        }
        catch (GameException ex)
        {
            return new("failed", null, [new(ErrorSeverity, "document", ex.Message)]);
        }
    }

    private static PreparationIssue[] Clarify(PreparationInput input, PreparationProposal proposal)
    {
        var issues = new List<PreparationIssue>();
        if (proposal.Scenes.Length == 0)
            issues.Add(new(ClarificationSeverity, "scenes", "尚无可确认的发生地点，请补充场景资料。"));
        if (proposal.StartSceneId.Length == 0)
            issues.Add(new(ClarificationSeverity, "startSceneId", "冒险从哪个已声明地点开始？请补充起点，不会默认取首个场景。"));
        for (var i = 0; i < proposal.Questions.Length; i++)
            if (!string.IsNullOrWhiteSpace(proposal.Questions[i]))
                issues.Add(new(ClarificationSeverity, $"questions[{i}]", proposal.Questions[i]));
        if (proposal.Routes.Length > 0 && input.TravelSeconds is null)
            issues.Add(new(ClarificationSeverity, "input.travelSeconds",
                "已声明路线需要主持明确选择旅行秒数；未选择时不会生成路线，也不会使用任何隐藏默认值。"));
        return issues.ToArray();
    }

    private static AdventureDocument Build(PreparationInput input, PreparationProposal proposal)
    {
        int seconds = input.TravelSeconds ?? 0;
        var scenes = proposal.Scenes.Select(scene => new ContentScene
        {
            Id = scene.Id,
            Title = scene.Title,
            Summary = scene.Summary,
            Arrival = scene.Arrival,
            Unlocated = true,
            SafeRest = scene.Id == proposal.StartSceneId && input.StartSafeRest,
            Exits = proposal.Routes.Where(r => r.From == scene.Id)
                .Select(r => new ContentExit(r.To, new ContentCondition(), seconds)).ToArray()
        }).ToArray();
        var knowledge = proposal.Knowledge.Select(k => new InitialKnowledgeEntry(k.Id, k.Kind, k.Name, k.Summary,
            k.SceneId, k.Visibility, k.RevealSceneId)).ToArray();
        return new AdventureDocument
        {
            FormatVersion = 1,
            Id = input.AdventureId,
            Version = input.AdventureVersion,
            Name = input.Name,
            StartSceneId = proposal.StartSceneId,
            SourceText = input.SourceText,
            Scenes = scenes,
            InitialKnowledge = knowledge.Length == 0 ? null : knowledge
        };
    }

    private static void ValidateEvidence(PreparationEvidence[]? evidence, PreparationInput input, string path, List<PreparationIssue> issues)
    {
        if (evidence is null || evidence.Length is < 1 or > PreparationLimits.MaximumEvidence)
        {
            issues.Add(new(ErrorSeverity, path + ".evidence", $"每条提议必须包含 1..{PreparationLimits.MaximumEvidence} 条来源摘录。"));
            return;
        }
        for (var i = 0; i < evidence.Length; i++)
        {
            var item = evidence[i];
            var itemPath = $"{path}.evidence[{i}]";
            if (item is null) { issues.Add(new(ErrorSeverity, itemPath, "来源摘录缺失。")); continue; }
            string? text = item.Field switch
            {
                "sourceText" => input.SourceText,
                "intent" => input.Intent,
                _ => null
            };
            if (text is null) { issues.Add(new(ErrorSeverity, itemPath + ".field", "来源字段只能是 sourceText 或 intent。")); continue; }
            if (item.Quote is null) { issues.Add(new(ErrorSeverity, itemPath + ".quote", "摘录不能为 null。")); continue; }
            if (item.Start < 0 || item.Length < 1 || item.Length > PreparationLimits.MaximumEvidenceCharacters ||
                item.Start > text.Length - item.Length)
            {
                issues.Add(new(ErrorSeverity, itemPath, "摘录范围超出对应原文，或超过 2000 字符。"));
                continue;
            }
            if (!string.Equals(item.Quote, text.Substring(item.Start, item.Length), StringComparison.Ordinal))
                issues.Add(new(ErrorSeverity, itemPath + ".quote", "摘录必须与原文对应范围逐字一致。"));
        }
    }

    private static void CheckText(string? value, int maximum, string path, bool required, bool multiline, List<PreparationIssue> issues)
    {
        if (value is null) { issues.Add(new(ErrorSeverity, path, "不能为 null。")); return; }
        if (required && string.IsNullOrWhiteSpace(value)) issues.Add(new(ErrorSeverity, path, "不能为空。"));
        if (value.Length > maximum) issues.Add(new(ErrorSeverity, path, $"不能超过 {maximum} 字符。"));
        if (value.Any(c => char.IsControl(c) && !(multiline && c is '\r' or '\n' or '\t')))
            issues.Add(new(ErrorSeverity, path, "包含不允许的控制字符。"));
    }

    private static void RequireText(string? value, int maximum, string path, bool required, bool multiline)
    {
        if (value is null) throw Invalid(path + " 不能为 null。");
        if (required && string.IsNullOrWhiteSpace(value)) throw Invalid(path + " 不能为空。");
        if (value.Length > maximum) throw Invalid($"{path} 不能超过 {maximum} 字符。");
        if (value.Any(c => char.IsControl(c) && !(multiline && c is '\r' or '\n' or '\t')))
            throw Invalid(path + " 包含不允许的控制字符。");
    }

    private static void RequireId(string? value, string path)
    {
        if (value is null || !IsId(value)) throw Invalid(path + " 必须是 1..64 位的 [A-Za-z0-9._-]，且以字母或数字开头。");
    }

    private static void RequireToken(string? value, int maximum, string path)
    {
        if (value is null || value.Length is < 1 || value.Length > maximum || !value.All(IsTokenCharacter))
            throw Invalid($"{path} 必须是 1..{maximum} 位的 [A-Za-z0-9._-]。");
    }

    private static bool IsId(string value) => value.Length is >= 1 and <= PreparationLimits.MaximumId &&
        char.IsAsciiLetterOrDigit(value[0]) && value.Skip(1).All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-');

    private static bool IsTokenCharacter(char c) => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-';

    private static GameException Invalid(string message) => new("invalid_preparation", message, 400);
}
