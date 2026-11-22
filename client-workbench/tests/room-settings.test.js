// Invitations are a host-only page, separate from story; preserve exact pending recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createApi,prepare,requestPath,versioned,seatMutations} from '../src/api.js';
import {createPendingStore} from '../src/pending.js';
import {renderRoomSettings} from '../src/room-settings.js';
import {installDom,settle} from './dom-shim.mjs';
installDom();
const session={baseUrl:'http://127.0.0.1:5197',campaignId:'c',accessToken:'a'.repeat(64)};
const metadata={roomNumber:'12345678',enabled:true,version:7};
const result={snapshot:{id:'c',version:8},resolution:{status:'resolved',kind:'party.room'},replayed:false};
test('room management uses separate GET and versioned host-only POST, with strict metadata',async()=>{
  assert.equal(requestPath('room',session),'/api/v1/campaigns/c/room');assert.equal(requestPath('room-config',session),'/api/v1/campaigns/c/room');
  assert.equal(versioned.has('room-config'),true);assert.equal(seatMutations.has('room-config'),false);
  assert.deepEqual(prepare('room-config',{requestId:'r',expectedVersion:7,enabled:true,password:'secret',actorId:'no'}),{requestId:'r',expectedVersion:7,enabled:true,password:'secret'});
  for(const body of [{...metadata,roomNumber:undefined},{...metadata,roomNumber:''},{...metadata,enabled:1},{...metadata,version:0}]){
    const api=createApi({fetchImpl:async()=>new Response(JSON.stringify(body))});await assert.rejects(api.request('room',session));
  }
  const methods=[];const api=createApi({fetchImpl:async(url,init)=>{methods.push(init.method);return new Response(JSON.stringify(init.method==='GET'?metadata:result));}});
  await api.request('room',session);await api.request('room-config',session,{requestId:'r',expectedVersion:7,enabled:true,password:'secret'});assert.deepEqual(methods,['GET','POST']);
});
test('room password pending survives loss and reload without changing original request',async()=>{
  const map=new Map(),storage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
  const pending=await createPendingStore({storage,session,cryptoObj:webcrypto});
  pending.capture('room-config',{requestId:'original',expectedVersion:7,enabled:true,password:'original-password'});
  const bodies=[];let calls=0;const api=createApi({fetchImpl:async(url,init)=>{bodies.push(init.body);if(++calls===1)throw Error('lost');return new Response(JSON.stringify({...result,replayed:true}));}});
  await assert.rejects(api.request('room-config',session,JSON.parse(pending.read().payloadJson)));
  const restored=await createPendingStore({storage,session,cryptoObj:webcrypto});const old=restored.read();await api.request(old.endpoint,session,JSON.parse(old.payloadJson));restored.complete();
  assert.equal(bodies[0],bodies[1]);assert.equal(restored.read(),null);
});
async function roomUi(overrides={}){
  const root=document.createElement('div'),writes=[];
  const ctx={scope:'host-room',snapshot:{version:7,party:{isHost:true,canInvite:false,members:[{id:'old',character:{name:'既有玩家'}}]}},
    read:async()=>metadata,submit:async(endpoint,payload)=>{writes.push({endpoint,payload});return result;},refresh:async()=>{},hasPending:()=>false,...overrides};
  await renderRoomSettings(root,ctx);return {root,ctx,writes,input:root.querySelector('input'),form:root.querySelector('form')};
}
test('host with existing players still sees room number and can invite without a second confirmation',async()=>{
  const f=await roomUi();assert.match(f.root.textContent,/12345678/);assert.match(f.root.textContent,/已有玩家.*1 人/);
  f.input.value='another-fixture-password';f.form.onsubmit({preventDefault(){}});await settle();
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].endpoint,'room-config');
  assert.equal(f.writes[0].payload.expectedVersion,7);assert.equal(f.writes[0].payload.enabled,true);assert.equal(f.input.value,'');
  assert.equal(document.body.querySelector('dialog'),null);
});
test('confirmed room update clears password even if refresh fails; disable sends no password',async()=>{
  const f=await roomUi({refresh:async()=>{throw Error('offline');}});f.input.value='fixture-password';f.form.onsubmit({preventDefault(){}});await settle();
  assert.equal(f.input.value,'');assert.match(f.root.textContent,/设置已保存，但刷新失败/);
  f.root.querySelectorAll('button').find(b=>b.textContent==='关闭新玩家加入').dispatchEvent('click');await settle();
  assert.equal(f.writes.length,2);assert.equal(f.writes[1].payload.enabled,false);assert.equal(f.writes[1].payload.password,'');
});
test('guest, pending, stale version and archived opening never issue a new room write',async()=>{
  const guest=document.createElement('div');await renderRoomSettings(guest,{snapshot:{party:{isHost:false}},read:()=>assert.fail('guest read')});assert.equal(guest.textContent,'');
  for(const overrides of [{hasPending:()=>true},{snapshot:{version:8,party:{isHost:true}}},{snapshot:{version:7,archived:true,party:{isHost:true}}}]){
    const f=await roomUi(overrides);f.input.value='fixture-password';f.form.onsubmit({preventDefault(){}});await settle();assert.equal(f.writes.length,0);
  }
});
test('disposed room read cannot update the view and an unknown write keeps only its original pending request',async()=>{
  const root=document.createElement('div');let release;const reading=renderRoomSettings(root,{scope:'old',snapshot:{party:{isHost:true}},read:()=>new Promise(r=>release=r)});
  const before=root.textContent;root.dispatchEvent('dispose');release(metadata);await reading;assert.equal(root.textContent,before);
  let pending=false,captured;
  const f=await roomUi({hasPending:()=>pending,submit:async(endpoint,payload)=>{captured={endpoint,payload};pending=true;throw Error('connection lost');}});
  f.input.value='fixture-password';f.form.onsubmit({preventDefault(){}});await settle();
  assert.equal(captured.endpoint,'room-config');assert.equal(captured.payload.password,'fixture-password');
  assert.equal(f.root.querySelector('fieldset').disabled,true);const original=captured;
  f.form.onsubmit({preventDefault(){}});await settle();assert.equal(captured,original);
});
