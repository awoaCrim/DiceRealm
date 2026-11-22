import {saveMutations} from './api.js';

export const timelineOf=snapshot=>snapshot?.timelineId??'';
export const pendingExpired=(record,snapshot)=>!!record&&(record.timelineId??'')!==timelineOf(snapshot);
export const canRetryPending=(record,snapshot)=>!!record&&(!pendingExpired(record,snapshot)||saveMutations.has(record.endpoint));

// Only authoritative Dead counts. Zero HP, unconscious and death saves are not death.
export function characterDead(character){
  return character?.dead===true||(character?.conditions||[]).some(condition=>typeof condition==='string'&&condition.toLowerCase()==='dead');
}
export function actionBlockReason(snapshot){
  if(snapshot?.lifecycle?.status==='game_over')return snapshot.lifecycle.message||'全队已阵亡，游戏结束。请由 DM 读档或重开。';
  if(characterDead(snapshot?.character))return '你的角色已死亡，不能发起行动或转述；仍可阅读记录和取消等待。';
  if(snapshot?.character&&snapshot?.lifecycle?.canAct===false)return snapshot.lifecycle.message||'当前角色不能发起新行动；仍可阅读记录和取消等待。';
  return '';
}
export function abandoningCommand(endpoint,payload={}){
  return ['adventure-stop','harness-cancel'].includes(endpoint)
    ||['intents/respond','rolls/respond'].includes(endpoint)&&payload.decision==='cancel';
}
