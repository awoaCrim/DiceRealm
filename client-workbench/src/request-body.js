// Turns a logged LLM HTTP body into readable sections for the request log. Pure, display only.
// Section: {title, items:[{label, text?, json?}]}. Unknown shapes fall back to raw JSON/text.
import {splitPromptRaw} from './prompt-sections.js';
const parse=text=>{try{return JSON.parse(text);}catch{return undefined;}};
const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
// Player/context turns are JSON inside a text part; show them structured instead of as one long line.
const textItem=(label,text)=>{const value=parse(text);return isObject(value)||Array.isArray(value)?{label,json:value}:{label,text:String(text??'')};};
const rest=(body,known)=>Object.fromEntries(Object.entries(body).filter(([key])=>!known.includes(key)));
const chars=text=>`${String(text||'').length} 字`;
const systemItems=(text,label)=>splitPromptRaw(text).map((block,index)=>({
  label:`${label} · ${index+1} ${block.title??'开头'}`,text:block.text}));

function geminiParts(parts,prefix){
  const label=kind=>prefix?`${prefix} · ${kind}`:kind;
  return (parts||[]).map(part=>{
    if(part?.thought===true)return {label:label('思考'),text:part.text||''};
    if(typeof part?.text==='string')return textItem(prefix,part.text);
    if(part?.functionCall)return {label:label(`调用工具 ${part.functionCall.name}`),json:part.functionCall.args??{}};
    if(part?.functionResponse)return {label:label(`工具结果 ${part.functionResponse.name}`),json:part.functionResponse.response??{}};
    return {label:prefix,json:part};
  });
}
function geminiRequest(body){
  const parts=body.systemInstruction?.parts||[];
  const system=parts.map(p=>p.text||'').join('');
  const contents=body.contents||[];
  const tools=(body.tools||[]).flatMap(t=>t.functionDeclarations||[]);
  const sections=[
    {title:'系统提示词',note:chars(system),items:parts.flatMap((p,i)=>typeof p?.text==='string'
      ?systemItems(p.text,parts.length>1?`systemInstruction.parts[${i}]`:'systemInstruction'):[{label:`systemInstruction.parts[${i}]`,json:p}])},
    {title:`对话内容（${contents.length} 条）`,items:contents.flatMap((c,i)=>geminiParts(c.parts,`#${i+1} ${c.role||''}`))},
    {title:`工具定义（${tools.length} 个）`,items:tools.map(t=>({label:t.name,text:t.description||'',json:t.parametersJsonSchema??t.parameters}))},
    {title:'生成参数',items:[{label:'generationConfig',json:body.generationConfig??{}}]}];
  const other=rest(body,['systemInstruction','contents','tools','generationConfig']);
  if(Object.keys(other).length)sections.push({title:'其他字段',items:[{label:'',json:other}]});
  return sections;
}
function openAiContent(content,label){
  if(typeof content==='string')return [textItem(label,content)];
  if(Array.isArray(content))return content.map(part=>part?.type==='text'?textItem(label,part.text):{label,json:part});
  return content==null?[]:[{label,json:content}];
}
function openAiRequest(body){
  const messages=body.messages||[],tools=body.tools||[];
  const indexed=messages.map((message,index)=>({message,index}));
  const system=indexed.filter(({message:m})=>m?.role==='system'),otherMessages=indexed.filter(({message:m})=>m?.role!=='system');
  const systemBlocks=system.flatMap(({message:m,index:i})=>typeof m.content==='string'
    ?systemItems(m.content,`#${i+1} system`)
    :Array.isArray(m.content)?m.content.flatMap((p,j)=>p?.type==='text'
      ?systemItems(p.text,`#${i+1} system.parts[${j}]`):[{label:`#${i+1} system.parts[${j}]`,json:p}])
      :openAiContent(m.content,`#${i+1} system`));
  const systemText=systemBlocks.map(entry=>entry.text??'').join('');
  const sections=[
    ...(system.length?[{title:'系统提示词',note:chars(systemText),items:systemBlocks}]:[]),
    {title:`消息（${otherMessages.length} 条）`,items:otherMessages.flatMap(({message:m,index:i})=>[
      ...openAiContent(m.content,`#${i+1} ${m.role||''}${m.tool_call_id?' · '+m.tool_call_id:''}`),
      ...(m.tool_calls||[]).map(call=>({label:`#${i+1} 调用工具 ${call.function?.name||''}`,json:parse(call.function?.arguments)??call.function?.arguments}))])},
    {title:`工具定义（${tools.length} 个）`,items:tools.map(t=>({label:t.function?.name||'',text:t.function?.description||'',json:t.function?.parameters}))}];
  const other=rest(body,['messages','tools']);
  if(Object.keys(other).length)sections.push({title:'参数',items:[{label:'',json:other}]});
  return sections;
}
export function describeRequest(text){
  const body=parse(text);
  if(!isObject(body))return [{title:'原文',items:[{label:'',text:String(text??'')}]}];
  if(body.contents||body.systemInstruction)return geminiRequest(body);
  if(Array.isArray(body.messages))return openAiRequest(body);
  return [{title:'JSON',items:[{label:'',json:body}]}];
}
export function describeResponse(text){
  const body=parse(text);
  if(!isObject(body))return text?[{title:'原文',items:[{label:'',text:String(text)}]}]:[];
  if(body.error)return [{title:'错误',items:[{label:'',json:body.error}]}];
  if(Array.isArray(body.candidates)){
    const candidate=body.candidates[0]||{};
    return [{title:'回复',note:candidate.finishReason||'',items:geminiParts(candidate.content?.parts,'')},
      ...usageSections('usageMetadata',body.usageMetadata)];
  }
  if(Array.isArray(body.choices)){
    const choice=body.choices[0]||{},message=choice.message||{};
    return [{title:'回复',note:choice.finish_reason||'',items:[
      ...(message.reasoning_content?[{label:'思考',text:message.reasoning_content}]:[]),
      ...openAiContent(message.content,''),
      ...(message.tool_calls||[]).map(call=>({label:'调用工具 '+(call.function?.name||''),json:parse(call.function?.arguments)??call.function?.arguments}))]},
      ...usageSections('usage',body.usage)];
  }
  return [{title:'JSON',items:[{label:'',json:body}]}];
}
function usageSections(label,value){
  if(value==null||(isObject(value)&&!Object.keys(value).length))return [];
  return [{title:'用量',items:[{label,json:value}]}];
}
