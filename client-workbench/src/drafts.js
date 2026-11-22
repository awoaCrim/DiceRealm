// drafts.js — 同一标签页内跨路由保留的未发送文字（例如尚未提交的裁定理由）。
// 只存在内存：不写入 storage，不进入请求，不跨战役（键包含战役编号）。
const store=new Map();
const normalize=key=>String(key??'');
export function draftKey(campaignId,rulingId){return normalize(campaignId)+'::'+normalize(rulingId);}
export function readDraft(key){const value=store.get(normalize(key));return typeof value==='string'?value:'';}
export function writeDraft(key,value){
  const scope=normalize(key),text=String(value??'');
  if(text.trim()==='')store.delete(scope);else store.set(scope,text);
  return text;
}
export function clearDraft(key){return store.delete(normalize(key));}
export function clearCampaignDrafts(campaignId){
  const prefix=normalize(campaignId)+'::';
  for(const key of [...store.keys()])if(key.startsWith(prefix))store.delete(key);
}
export function draftCount(){return store.size;}
