using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

// Private, frozen per model slot. These are the existing read projections, never public
// context, new world references, or proof that a mechanical action has happened.
public sealed record HarnessReadPreload(string Audience, string[] Omitted,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] JsonElement? Encounter = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] JsonElement? RulesScope = null);

public static class HarnessReadPreloads
{
    public const int ArrivalBytes = 8 * 1024;
    public const int EncounterBytes = 12 * 1024;
    private const string SceneNotice = "Current visited scene only. Arrival is imported public entry prose, not a new event or a claim that past conditions persist; current state and later events take precedence. arrivalStatus=included supplies the complete prose; omitted_size/omitted_transport means it was not supplied, NOT absent scenery. Read context_read scope=scene only when the omitted detail is needed.";
    public const string Instructions = """

        # 已供情境与同轮读取
        最新execution_state已提供context/候选、self、workingContext、scenePresentation及board；先使用当前版本实际提供的内容，不为完成固定流程再次context_read、map_state_read或rules_scope。
        scenePresentation.arrivalStatus=included时已给当前场景完整入场原文；它不是刚发生的新事件，后续事实优先。readPreload.encounter与rulesScope分别复用encounter_read与rules_scope结果。readPreload只供DM推理，隐藏名单、位置、骰点和他人发现不可直接复制到公开正文、memory或continuity；实际知情者与交付权限仍按原合同。
        omitted及arrivalStatus明确指出因大小或传输预算未提供的资料，省略不表示不存在；需要该项细节时仍可调用原读取工具。scope=character/items、规则正文、未供历史及checks_result scope=scene继续按需补查，不把摘要当完整资料。
        需要多个互相独立的只读查询时，在同一条回复中一起发出多个tool call，避免每读一项再请求一轮模型。依赖前一个结果的ID、检定结果或写入后新状态的查询必须等结果；不要把写操作、确认或等待步骤并入这种读取批次。已供同版资料无需为凑批次重复读取。
        需要时直接调用内置主持工具：dm_reference查询2024检定、物件、陷阱和危险；encounter_plan按实际队伍规划遭遇；treasure_generate生成2024战利品方案。无需让用户打开参考网页或查看来源。规划不代表场景存在该敌人/奖励，不授予物品或改写战斗；后续用已有执行工具，未覆盖规则不假装自动结算。
        """;

    private static int Bytes<T>(T value) => Encoding.UTF8.GetByteCount(HarnessProviderJson.Serialize(value));

    public static HarnessExecutionFrame Capture(HarnessExecutionFrame frame, object encounter, object rulesScope)
    {
        var scene = frame.ScenePresentation!;
        bool omitArrival = Bytes(scene.Arrival) > ArrivalBytes;
        var encoded = HarnessJson.Element(encounter);
        bool omitEncounter = Bytes(encoded) > EncounterBytes;
        return frame with
        {
            ScenePresentation = scene with { Arrival = omitArrival ? "" : scene.Arrival,
                ArrivalStatus = omitArrival ? "omitted_size" : "included", Notice = SceneNotice },
            ReadPreload = new("dm_only", omitEncounter ? ["encounter:size"] : [],
                omitEncounter ? null : encoded, HarnessJson.Element(rulesScope))
        };
    }

    // Shed optional preloads before selecting a shorter history, without cutting prose,
    // altering native tool exchanges, or changing the existing transport/model limits.
    public static HarnessExecutionFrame OmitForTransport(HarnessExecutionFrame frame) => frame with
    {
        ScenePresentation = frame.ScenePresentation! with { Arrival = "", ArrivalStatus = "omitted_transport" },
        ReadPreload = new("dm_only", ["encounter:transport", "rules_scope:transport"])
    };

    public static void Validate(HarnessExecutionFrame frame, int contract)
    {
        bool expected = contract >= 56 && frame.Agent?.Role != "combat" && frame.Opening?.Generating != true;
        if (expected != (frame.ReadPreload is not null) || expected != (frame.ScenePresentation?.ArrivalStatus is not null))
            throw new InvalidDataException("Invalid read preload version or audience.");
        if (frame.ReadPreload is not { } reads) return;
        var scene = frame.ScenePresentation!;
        if (reads.Audience != "dm_only" || reads.Omitted is null ||
            reads.Omitted.Distinct().Count() != reads.Omitted.Length ||
            reads.Omitted.Any(s => s is not ("encounter:size" or "encounter:transport" or "rules_scope:transport")) ||
            (reads.Encounter is null) != reads.Omitted.Any(s => s.StartsWith("encounter:", StringComparison.Ordinal)) ||
            (reads.RulesScope is null) != reads.Omitted.Contains("rules_scope:transport") ||
            reads.Encounter is { } encounter && (encounter.ValueKind != JsonValueKind.Object ||
                !encounter.TryGetProperty("version", out var version) || !version.TryGetInt32(out int actual) || actual != frame.Version || Bytes(encounter) > EncounterBytes) ||
            reads.RulesScope is { ValueKind: not JsonValueKind.Object } ||
            scene.Notice != SceneNotice || scene.ArrivalStatus is not ("included" or "omitted_size" or "omitted_transport") ||
            scene.ArrivalStatus != "included" && scene.Arrival.Length != 0 || Bytes(scene.Arrival) > ArrivalBytes)
            throw new InvalidDataException("Invalid bounded read preload.");
    }
}
