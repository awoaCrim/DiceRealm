// Joining a room with a full build (docs/room-onboarding.md). The join is written down before it is
// sent; until the server answers it definitively only that exact request is retried, so a lost
// answer can never create a second seat. Saved seats are the only copy of their access tokens.
import {newUuid,randomHex} from '../api.js';
import {normalizeSession} from '../session.js';

const JOIN_KEY='dicerealm.play.join.v1',DRAFT_KEY='dicerealm.play.build.v1';
const SEATS_KEY='dicerealm.play.seats.v1',CURRENT_KEY='dicerealm.play.session.v1';
const parse=(storage,key)=>{const raw=storage.getItem(key);return raw?JSON.parse(raw):null;};

export const validRoomNumber=value=>/^\d{8}$/.test(value);

// ── seats on this browser ──
export function seats(storage,origin){
  let list=[];
  try{list=parse(storage,SEATS_KEY)||[];}catch{/* An unreadable list is replaced on the next save. */}
  const valid=list.flatMap(s=>{try{return [{...normalizeSession(s,origin),label:String(s.label||'')}];}catch{return [];}});
  // The page's last seat predates the list on browsers that used the first version of this page.
  try{const current=parse(storage,CURRENT_KEY);if(current){const s=normalizeSession(current,origin);if(!valid.some(v=>same(v,s)))valid.push({...s,label:''});}}
  catch{/* Not a seat. */}
  return valid;
}
const same=(a,b)=>a.campaignId===b.campaignId&&a.accessToken===b.accessToken;
export function rememberSeat(storage,origin,session,label=''){
  const list=seats(storage,origin).filter(s=>!same(s,session));
  const old=seats(storage,origin).find(s=>same(s,session));
  list.unshift({baseUrl:session.baseUrl,campaignId:session.campaignId,accessToken:session.accessToken,label:label||old?.label||''});
  storage.setItem(SEATS_KEY,JSON.stringify(list));
  storage.setItem(CURRENT_KEY,JSON.stringify(normalizeSession(session,origin)));
}
export function forgetSeat(storage,origin,session){
  storage.setItem(SEATS_KEY,JSON.stringify(seats(storage,origin).filter(s=>!same(s,session))));
  const current=parse(storage,CURRENT_KEY);
  if(current&&same(current,session))storage.removeItem(CURRENT_KEY);
}
export function currentSeat(storage,origin){
  try{const raw=parse(storage,CURRENT_KEY);return raw?normalizeSession(raw,origin):null;}catch{return null;}
}
export const leaveSeat=storage=>storage.removeItem(CURRENT_KEY);

// ── the build draft ──
export function savedDraft(storage,catalog){
  try{
    const value=parse(storage,DRAFT_KEY);
    // Rule data changed under the draft: its ids may no longer exist, so the builder starts over.
    return value?.build?.revision===catalog.revision&&Number.isInteger(value.step)?value:null;
  }catch{return null;}
}
export const saveDraft=(storage,value)=>storage.setItem(DRAFT_KEY,JSON.stringify(value));

// ── the pending join ──
export function pendingJoin(storage){
  let value;
  try{value=parse(storage,JOIN_KEY);}catch{throw new Error('未确认加入的本机记录损坏，已阻止新的加入。');}
  if(value&&(!validRoomNumber(value.roomNumber)||typeof value.password!=='string'||typeof value.requestId!=='string'
    ||!/^[a-f0-9]{64}$/.test(value.accessToken)||!value.build?.identity))throw new Error('未确认加入的记录不完整，已阻止新的加入。');
  return value;
}
export function beginJoin(storage,roomNumber,password,build){
  if(pendingJoin(storage))throw new Error('上一次加入还没有确认，请先重试原请求。');
  const request={roomNumber,password,requestId:newUuid(),accessToken:randomHex(32),build};
  storage.setItem(JOIN_KEY,JSON.stringify(request));
  return request;
}
// Sends the saved join. A definitive refusal (wrong room or password, a full party, a build the
// server rejects) clears it so the player can change and try again; a timeout, a lost answer, rate
// limiting or a server failure keeps it for an exact retry.
export async function sendJoin(api,storage,origin){
  const request=pendingJoin(storage);
  if(!request)throw new Error('没有待确认的加入请求。');
  try{
    const result=await api.request('room-join',null,request);
    const session=normalizeSession({baseUrl:origin,campaignId:result.snapshot.id,accessToken:result.accessToken},origin);
    rememberSeat(storage,origin,session,[result.snapshot.character.name,result.snapshot.name].filter(Boolean).join(' · '));
    storage.removeItem(JOIN_KEY);
    storage.removeItem(DRAFT_KEY);
    return {session,snapshot:result.snapshot};
  }catch(error){
    if(error.status&&!error.unconfirmed&&error.status!==429){storage.removeItem(JOIN_KEY);error.cleared=true;}
    throw error;
  }
}
