using System.Security.Cryptography;
using System.Text;

namespace DiceRealm.Server.Domain;

// An allowlisted, host-authored ledger. Preview and commit use the same pure calculation.
// No attributes, proficiency, level, maximum HP, build, ownership or scene patches.
public static class CharacterAdjustments
{
    private sealed record Evaluation(Character Character, CharacterChangeView[] Changes, string[] Warnings, int RulingIndex);
    public static AdjustmentPreview Preview(Campaign c,AdjustCharacterRequest request)
    {
        var result=Evaluate(c,request);
        return new(c.Version,request.ActorId,result.Character.Name,result.Changes,result.Warnings);
    }
    public static Resolution Apply(Campaign c,AdjustCharacterRequest request)
    {
        var result=Evaluate(c,request); PartyEngine.SetCharacter(c,request.ActorId,result.Character);CharacterEngine.Sync(c);
        if(result.RulingIndex>=0)
        {
            var r=c.PendingRulings[result.RulingIndex];
            c.PendingRulings[result.RulingIndex]=r with { Status="resolved",Outcome=r.Status=="pending"?"effects":r.Outcome,
                Rationale=r.Status=="pending"?request.Rationale.Trim():r.Rationale,RuleSource=r.Status=="pending"?request.RuleSource.Trim():r.RuleSource,
                ResolvedBy=r.Status=="pending"?c.ActingActorId:r.ResolvedBy,ResolvedAt=r.Status=="pending"?DateTimeOffset.UtcNow:r.ResolvedAt,
                EffectsRequestId=request.RequestId,Effects=result.Changes };
        }
        string summary=$"主持调整 {result.Character.Name}："+string.Join("；",result.Changes.Select(x=>$"{x.Label} {x.Before} → {x.After}"))+
            $"。理由：{request.Rationale.Trim()}。依据：{request.RuleSource.Trim()}。这些是已确认的记录，不代表 AI 自动判定。";
        return new("resolved","character.adjust",summary,null,result.Changes.Select(x=>x.Operation+":"+x.Key+":"+x.Before+"->"+x.After).ToArray(),request.RulingId);
    }
    private static Evaluation Evaluate(Campaign c,AdjustCharacterRequest request)
    {
        PartyEngine.RequireHost(c);
        if(c.Archived||CombatEngine.InCombat(c))throw new GameException("adjustment_unavailable","归档或现有自动遭遇进行中不能使用此记录入口。",409);
        if(c.Version!=request.ExpectedVersion)throw new GameException("stale_version","状态已更新，请重新预览调整。",409);
        Text(request.Rationale,1000,"理由");Text(request.RuleSource,240,"来源");
        if(request.ActorId is null||request.RulingId is null||request.ActorId.Length>80||request.RulingId.Length>80||request.Changes is null||request.Changes.Length is <1 or >16
            ||request.Changes.Any(x=>x is null||x.Operation is null||x.Key is null||x.Name is null||x.Key.Length>240||x.Name.Length>60||x.Key.Any(char.IsControl)))
            throw new GameException("invalid_adjustment","调整字段、行数或长度不合法。");
        var target=PartyEngine.Characters(c).FirstOrDefault(p=>p.Id==request.ActorId).Character
            ??throw new GameException("invalid_seat","请选择仍有效的角色席位。",409);
        var ch=PlayResources.Ensure(target);int rulingIndex=-1;
        if(request.RulingId!="")
        {
            rulingIndex=c.PendingRulings.FindIndex(r=>r.Id==request.RulingId);
            if(rulingIndex<0)throw new GameException("ruling_unavailable","裁定记录不存在。",409);
            var r=c.PendingRulings[rulingIndex];
            if(r.ActorId!=request.ActorId||r.SceneId!=c.SceneId||r.CombatId!=""||r.EffectsRequestId!=""||r.Outcome=="reject")
                throw new GameException("ruling_context_changed","裁定的角色/场景已改变、已驳回或已落实过效果。请查看原记录，不重复应用。",409);
        }
        var changes=new List<CharacterChangeView>();var warnings=new List<string>();var keys=new HashSet<string>();
        void Add(string op,string key,string label,object before,object after) { if(!Equals(before,after))changes.Add(new(op,key,label,before.ToString()!,after.ToString()!)); }
        foreach(var change in request.Changes)
        {
            string op=change.Operation,key=change.Key;int value=change.Value;
            string group=op is "damage" or "heal" or "hp"?"hp":op;
            if(!keys.Add(group+":"+key))throw new GameException("invalid_adjustment","同一字段不能在一份调整中重复出现。");
            if(op is not ("resource.define" or "item.define")&&change.Name!="")throw new GameException("invalid_adjustment","此调整不能改名。");
            if(op is "damage" or "heal" or "hp" or "temporary-hp" or "exhaustion" && key!="")throw new GameException("invalid_adjustment","此字段不接受额外键。");
            switch(op)
            {
                case "damage":
                    Range(value,1,9999);int absorbed=Math.Min(ch.TemporaryHitPoints,value),hp=Math.Max(0,ch.HitPoints-(value-absorbed));
                    Add(op,"temporary-hp","临时 HP",ch.TemporaryHitPoints,ch.TemporaryHitPoints-absorbed);Add(op,"hp","HP",ch.HitPoints,hp);
                    ch=ch with {HitPoints=hp,TemporaryHitPoints=ch.TemporaryHitPoints-absorbed};
                    warnings.Add("伤害数额按主持输入的最终值记录，先扣临时 HP；未再计算抗性、免疫、死亡或濒死效果。");break;
                case "heal":
                    Range(value,1,9999);int healed=Math.Min(ch.MaxHitPoints,ch.HitPoints+value);Add(op,"hp","HP",ch.HitPoints,healed);ch=ch with {HitPoints=healed};break;
                case "hp":
                    Range(value,0,ch.MaxHitPoints);Add(op,"hp","HP（直接校正）",ch.HitPoints,value);ch=ch with {HitPoints=value};break;
                case "temporary-hp":
                    Range(value,0,9999);Add(op,key,"临时 HP（替换，不叠加）",ch.TemporaryHitPoints,value);ch=ch with {TemporaryHitPoints=value};break;
                case "exhaustion":
                    Range(value,0,6);Add(op,key,"Exhaustion 等级",ch.Exhaustion,value);ch=ch with {Exhaustion=value};break;
                case "condition":
                    Range(value,0,1);if(!PlayCatalog.Conditions.Contains(key))throw new GameException("invalid_adjustment","请选择已列出的状态；Exhaustion 用独立等级字段。");
                    bool before=ch.Conditions.Contains(key);Add(op,key,key,before?"有":"无",value==1?"有":"无");
                    ch=ch with {Conditions=value==1?ch.Conditions.Append(key).Distinct().ToArray():ch.Conditions.Where(x=>x!=key).ToArray()};break;
                case "resource":
                    var resource=ch.Resources.SingleOrDefault(r=>r.Name==key)??throw new GameException("invalid_adjustment","只能校正已有资源的当前值。");
                    Range(value,0,resource.Maximum);Add(op,key,key,resource.Current,value);ch=ch with {Resources=ch.Resources.Select(r=>r.Name==key?r with {Current=value}:r).ToArray()};break;
                case "resource.define":
                    if(key!="")throw new GameException("invalid_adjustment","新增主持资源不接受已有键。");
                    Text(change.Name,60,"资源名");Range(value,1,9999);string name="DM: "+change.Name.Trim();
                    if(ch.Resources.Length>=64||ch.Resources.Any(r=>r.Name==name))throw new GameException("invalid_adjustment","资源已存在或已达到上限。");
                    ch=ch with {Resources=[..ch.Resources,new(name,0,value,"manual","主持定义的计数器；不会随长短休自动恢复。","DM")]};
                    Add(op,name,name,"不存在","0 / "+value);break;
                case "inventory":
                    Range(value,0,9999);var item=ch.Inventory.SingleOrDefault(i=>i.Id==key);string itemName=item?.Name??PlayCatalog.ItemName(key);
                    if(itemName==""||item is null&&value==0)throw new GameException("invalid_adjustment","请选择已有物品或已验证目录物品。");
                    Add(op,key,itemName,item?.Quantity??0,value);
                    var inventory=ch.Inventory.Where(i=>i.Id!=key).ToList();if(value>0)inventory.Add(new(key,itemName,value,item?.Equipped==true));
                    ch=ch with {Inventory=inventory.ToArray()};break;
                case "item.define":
                    if(key!="")throw new GameException("invalid_adjustment","新增记录物品不接受已有键。");
                    Text(change.Name,60,"物品名");Range(value,1,9999);
                    string itemId="dm-item:"+Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(change.Name.Trim())))[..16];
                    if(ch.Inventory.Any(i=>i.Id==itemId))throw new GameException("invalid_adjustment","该记录物品已存在，请调整其数量。");
                    ch=ch with {Inventory=[..ch.Inventory,new(itemId,change.Name.Trim(),value,false)]};Add(op,itemId,change.Name.Trim(),"不存在",value);
                    warnings.Add("主持记录物品仅保留名称和数量，不从名称推导护甲、武器或其他规则效果。");break;
                default:throw new GameException("invalid_adjustment","未知的调整操作；禁止任意状态补丁。");
            }
        }
        EquipmentLoadout.RequireInventory(ch);
        if(ch.Inventory.Length>400)throw new GameException("invalid_adjustment","物品种类超过当前上限。");
        if(changes.Count==0)throw new GameException("adjustment_no_change","没有实际变化，未提交任何裁定。",409);
        if(ch.HitPoints==0||ch.Exhaustion>=6)warnings.Add("HP 为零或 Exhaustion 六级时，濒死、死亡与复苏仍需主持处理；没有自动增加或清除 Unconscious。");
        if(ch.Conditions.Length>0)warnings.Add("状态按名称记录；不会自动完成持续时间、重复豁免、专注或全部连带效果。");
        ch=ch with {ShortRestDiceAvailable=false,PlayState=ch.PlayState! with {PreparationOpen=false}};
        return new(ch,changes.ToArray(),warnings.Distinct().ToArray(),rulingIndex);
    }
    private static void Range(int value,int min,int max) { if(value<min||value>max)throw new GameException("invalid_adjustment",$"值须在 {min}..{max} 之间。"); }
    private static void Text(string? value,int max,string label) { if(string.IsNullOrWhiteSpace(value)||value.Length>max||value.Any(char.IsControl))throw new GameException("invalid_adjustment",label+"不能为空、过长或含控制字符。"); }
}
