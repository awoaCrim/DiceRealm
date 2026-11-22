import {ruleName} from './rule-labels.js';
import {recordedCheckText} from './combat-log.js';

const writes=new Set(['world_record','opening_commit','token_spawn','token_move','token_update','token_remove','map_select','map_request',
  'encounter_prepare','encounter_engage','combat_continue','combat_delegate','actions_propose','world_route_propose']);
const rolls=new Set(['check_request','checks_result']);
const short=value=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,72):'';
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const names=values=>(Array.isArray(values)?values:[]).map(x=>short(x?.name||x?.title)).filter(Boolean).slice(0,2).join('、');
function result(detail){
  const content=detail?.response?.content;
  if(typeof content!=='string')return object(content);
  try{return object(JSON.parse(content));}catch{return {};}
}

// Only known public tool-result fields enter the one-line summary. Never summarize
// model text, reasoning, arbitrary JSON, or a proposed result as an applied fact.
export function stepSummary(step,detail,label){
  const data=result(detail),request=object(detail?.request);
  let category=step.kind==='model'?'model':rolls.has(step.tool)?'roll':writes.has(step.tool)||step.kind==='final'?'write':'query';
  let text=label,state=step.status==='done'?(step.kind==='final'?'已保存':'已返回'):'进行中';
  if(detail?.response?.isError){
    const code=short(data.code)||'工具返回错误';
    return {category:'error',text:'被拒绝：'+code,state:category==='write'?'未写入':'未成功'};
  }
  if(step.kind==='tool'&&detail){
    if(step.tool==='rules_search')text='查找规则'+(short(request.query)?'：'+short(request.query):'');
    else if(step.tool==='rules_read')text='查阅规则'+(short(data.name)?'：'+short(data.name):'');
    else if(step.tool==='dm_reference')text='查阅主持参考'+({checks:'：检定难度',objects:'：物件 AC 与生命',traps:'：陷阱',hazards:'：危险环境',cr:'：挑战等级'}[request.topic]||'');
    else if(rolls.has(step.tool)){
      const records=data.rolls||data.entries;
      const checks=[data.resolution?.check,...(Array.isArray(records)?records:[]).map(x=>x.result?.check)].filter(Boolean);
      if(checks.length)text=recordedCheckText(checks[0])+(checks.length>1?' · 另有 '+(checks.length-1)+' 项':'');
      else if(step.tool==='check_request'){text='请求检定'+(request.skill||request.ability?'：'+ruleName(request.skill||request.ability):'')+(Number.isFinite(request.dc)?' DC'+request.dc:'');state='已请求';}
      else text='读取检定结果 · 尚无已记录骰点';
    }else if(step.tool==='world_record'&&data.protocol?.applied===true){text=names(data.memory)?'更新世界：'+names(data.memory):'保存叙事与世界记录';state='已保存';}
    else if(step.tool==='world_search')text='查找世界信息'+(short(request.query)?'：'+short(request.query):'');
    else if(step.tool==='ask_player')text='等待玩家回答'+(short(request.question)?'：'+short(request.question):'');
  }
  return {category,text,state};
}
