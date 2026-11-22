// tasking.js — 主持任务的纯分组模型。
// 只整理服务端已经保存的事实：不生成剧情、不推断检定难度、不补写玩家行动。
// 所有函数都是纯函数，便于测试，也保证界面不会因为缺少字段而编造内容。

export const outcomeLabels={narrative:'已记录叙事',reject:'请求未获准',check:'已做检定',story:'已落实剧情后果',board_move:'已结算移动',effects:'已落实角色效果'};
export const questStatusLabels={active:'进行中',completed:'已完成',failed:'失败',abandoned:'已放弃'};

/** 把请求分成「待回应 / 等待落实 / 已回应」三组，互不重叠且顺序稳定。 */
export function groupRulings(rulings){
  const pending=[],awaitingRoll=[],awaitingStory=[],settled=[];
  for(const ruling of rulings||[]){
    if(!ruling)continue;
    if(ruling.status==='pending')pending.push(ruling);
    else if(ruling.status==='awaiting_roll')awaitingRoll.push(ruling);
    // 只有尚未落实后果的检定需要跟进；文字回应与棋盘移动提交即完成。
    else if(ruling.status==='resolved'&&ruling.outcome==='check'&&!ruling.story&&!ruling.effectsRequestId)awaitingStory.push(ruling);
    else settled.push(ruling);
  }
  return {pending,awaitingRoll,awaitingStory,settled};
}

/** 主持待办数：待审核角色 + 待裁定 + 待落实后果 + 等待掷骰；请求错误需另行读取，不计入。 */
export function hostTaskCount(snapshot){
  if(!snapshot?.party?.isHost)return 0;
  const {pending,awaitingRoll,awaitingStory}=groupRulings(snapshot.pendingRulings);
  const reviews=(snapshot.party.members||[]).filter(m=>!m.revoked&&m.review?.status==='pending').length;
  return reviews+pending.length+awaitingRoll.length+awaitingStory.length;
}

/** 用队伍成员资料把席位编号换成角色名；查不到时保留原始编号，不假装知道。 */
export function actorLabel(snapshot,actorId){
  if(!actorId)return '未知席位';
  const member=(snapshot?.party?.members||[]).find(m=>m.id===actorId);
  return member?.character?.name||member?.id||actorId;
}

/** 当前场景直接用快照；其他场景名只从已知地图节点读取，不发明地点。 */
export function sceneLabel(snapshot,sceneId){
  if(!sceneId)return snapshot?.scene?.title||'';
  if(sceneId===snapshot?.scene?.id)return snapshot?.scene?.title||sceneId;
  const node=(snapshot?.map?.nodes||[]).find(n=>n.id===sceneId);
  return node?.title||sceneId;
}

/** 最近已经回应的请求：新到旧排序，只取前若干条。 */
export function recentConfirmations(rulings,limit=6){
  const count=Number.isInteger(limit)&&limit>0?limit:6;
  return groupRulings(rulings).settled
    .slice()
    .sort((a,b)=>String(b.resolvedAt||'').localeCompare(String(a.resolvedAt||'')))
    .slice(0,count);
}

/** 当前目标来自已导入剧本投影；没有内容时返回空数组而不是占位故事。 */
export function goals(snapshot){
  return (snapshot?.world?.quests||[]).filter(Boolean).map(q=>({
    id:q.id||'',title:q.title||'',status:q.status||'',summary:q.summary||'',
    objectives:(q.objectives||[]).map(o=>({text:o?.text||'',complete:!!o?.complete}))}));
}

/** 下一步选项：已声明分支 + 当前可用 / 不可用行动。未声明时保持空。 */
export function nextChoices(snapshot){
  const branches=(snapshot?.world?.branches||[]).filter(Boolean).map(b=>({id:b.id||'',label:b.label||'',choice:b.choice||''}));
  const options=((snapshot?.actionOptions?.length?snapshot.actionOptions:snapshot?.availableActions)||[]).filter(a=>!['character.','equipment.','rest.','growth.','combat.'].some(prefix=>a?.kind?.startsWith(prefix)));
  const available=[],blocked=[];
  for(const action of options){
    if(!action)continue;
    const reason=action.details?.unavailableReason||'';
    if(reason)blocked.push({label:action.label||action.kind||'',reason});
    else available.push({label:action.label||action.kind||'',cost:action.details?.cost||'',range:action.details?.range||'',note:action.details?.note||''});
  }
  return {branches,available,blocked};
}

// 主持台诚实的限制说明：工作台没有「为尚未提出的新行动预先查询难度」的接口。
export const dcNotice='这些行动来自当前战役。回应玩家时，可以采用剧本已写明的检定条件，或自行裁定；没有声明时不会替你猜 DC。';

/** 准备清单：每一步都对应真实的服务端状态，没有状态时明确写「未知」。 */
export function prepChecklist(snapshot){
  const content=snapshot?.content||{status:'unknown'};
  return [
    {key:'adventure',label:'导入剧本',done:!!content.adventure,href:'#/content',
      detail:content.adventure?content.adventure.name+' @ '+content.adventure.version:'尚未导入剧本；没有默认故事'},
    {key:'prompts',label:'导入提示词',done:!!content.prompts,href:'#/content',
      detail:content.prompts?content.prompts.name+' @ '+content.prompts.version:'尚未导入提示词包'},
    {key:'activate',label:'检查并启用',done:content.status==='active',href:'#/content',
      detail:content.status==='active'?'已启用，可在 Unity 同步游玩':(content.message||'启用前需要剧本与提示词均已导入')}

  ];
}

/** 版本、标识与原始事实属于次要信息，统一经由高级详情展示。 */
export function advancedFacts(snapshot){
  return {campaignId:snapshot?.id||'',version:Number.isInteger(snapshot?.version)?snapshot.version:null,
    archived:!!snapshot?.archived,facts:(snapshot?.facts||[]).map(String)};
}
