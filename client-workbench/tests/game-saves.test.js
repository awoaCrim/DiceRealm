import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createApi,prepare,requestPath,validGameSaveList} from '../src/api.js';
import {createPendingStore} from '../src/pending.js';
import {pendingExpired,canRetryPending,actionBlockReason,abandoningCommand} from '../src/campaign-state.js';
import {renderSaves} from '../src/game-saves.js';
import {installDom,settle} from './dom-shim.mjs';

const session={baseUrl:'http://127.0.0.1:5197',campaignId:'campaign',accessToken:'a'.repeat(64)};
const slot={id:'slot',name:'港口初遇',revision:1,createdAt:'2026-10-18T00:00:00Z',sceneTitle:'港口',elapsedSeconds:360,version:7,kind:'manual',party:[{actorId:'player',name:'旅人',level:1,dead:false}]};
const list={entries:[slot],canSave:true,reason:''};
const snapshot={id:'campaign',version:7,timelineId:'old',party:{isHost:true}};
const response={snapshot,saveId:'slot',replayed:false};
const button=(root,name)=>root.querySelectorAll('button').find(b=>b.textContent===name);

test('save commands use exact path/body and reject incomplete save metadata',async()=>{
  assert.equal(requestPath('adventure-save-load',session,{saveId:'slot'}),'/api/v1/campaigns/campaign/adventure/saves/slot/load');
  assert.equal(requestPath('adventure-save-delete',session,{saveId:'slot'}),'/api/v1/campaigns/campaign/adventure/saves/slot/delete');
  assert.deepEqual(prepare('adventure-save-load',{requestId:'r',expectedVersion:7,saveId:'slot',expectedSaveRevision:2,actorId:'forged'}),{requestId:'r',expectedVersion:7,expectedSaveRevision:2});
  assert.deepEqual(prepare('adventure-save-delete',{requestId:'r',expectedVersion:7,saveId:'slot',expectedSaveRevision:2}),{requestId:'r',expectedSaveRevision:2});
  assert.equal(validGameSaveList(list),true);
  for(const bad of [{...list,canSave:undefined},{...list,entries:[{...slot,revision:0}]},{...list,entries:[{...slot,party:[{name:'旅人'}]}]}])assert.equal(validGameSaveList(bad),false);
  const api=createApi({fetchImpl:async()=>new Response(JSON.stringify({snapshot,saveId:'slot'}))});
  await assert.rejects(api.request('adventure-save',session,{requestId:'r',expectedVersion:7,name:'港口'}));
});

test('lost save response reload retries exact payload and frozen timeline, not the current branch',async()=>{
  const map=new Map(),storage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
  const pending=await createPendingStore({storage,session,cryptoObj:webcrypto});
  pending.capture('adventure-save-load',{requestId:'same',expectedVersion:7,saveId:'slot',expectedSaveRevision:1},{timelineId:'old'});
  const seen=[];const api=createApi({fetchImpl:async(url,init)=>{seen.push({url,body:init.body,headers:new Headers(init.headers)});if(seen.length===1)throw Error('lost');return new Response(JSON.stringify({...response,snapshot:{...snapshot,timelineId:'new',version:3},replayed:true}));}});
  let record=pending.read();await assert.rejects(api.request(record.endpoint,session,JSON.parse(record.payloadJson),{timelineId:record.timelineId}));
  const reloaded=await createPendingStore({storage,session:{...session,timelineId:'new'},cryptoObj:webcrypto});record=reloaded.read();
  assert.equal(pendingExpired(record,{timelineId:'new'}),true);assert.equal(canRetryPending(record,{timelineId:'new'}),true);
  await api.request(record.endpoint,{...session,timelineId:'new'},JSON.parse(record.payloadJson),{timelineId:record.timelineId});
  assert.equal(seen[0].body,seen[1].body);assert.equal(seen[0].headers.get('X-DiceRealm-Timeline'),'old');assert.equal(seen[1].headers.get('X-DiceRealm-Timeline'),'old');
  assert.equal(canRetryPending({...record,endpoint:'adventure-input'},{timelineId:'new'}),false);
  assert.equal(pendingExpired({endpoint:'actions'},{}),false);assert.equal(pendingExpired({endpoint:'actions'},{timelineId:'new'}),true);
  reloaded.complete();assert.equal(reloaded.read(),null);
});

test('death and game over block new player actions but preserve cancellation and zero HP semantics',()=>{
  assert.equal(actionBlockReason({character:{hitPoints:0,conditions:['Unconscious','Prone']}}),'');
  assert.match(actionBlockReason({character:{conditions:['Dead']}}),/死亡/);
  assert.equal(actionBlockReason({lifecycle:{status:'game_over',message:'全队已阵亡。',canAct:false}}),'全队已阵亡。');
  assert.equal(abandoningCommand('rolls/respond',{decision:'cancel'}),true);assert.equal(abandoningCommand('rolls/respond',{decision:'roll'}),false);
  assert.equal(abandoningCommand('adventure-stop'),true);
});

async function ui(overrides={}){
  installDom();const root=document.createElement('main'),writes=[],errors=[];
  const ctx={snapshot:{...snapshot},read:async()=>list,hasPending:()=>false,report:e=>errors.push(e),submit:async(endpoint,payload)=>{writes.push({endpoint,payload});return response;},...overrides};
  document.body.append(root);await renderSaves(root,ctx);return {root,ctx,writes,errors};
}

test('DM new save names and submits once without another confirmation',async()=>{
  const f=await ui();assert.match(f.root.textContent,/港口初遇/);assert.match(f.root.textContent,/旅人/);
  button(f.root,'新建存档').dispatchEvent('click');const dialog=document.body.querySelector('dialog'),input=dialog.querySelector('input');
  assert.equal(button(dialog,'保存').hasAttribute('disabled'),true);input.value='出发前';input.dispatchEvent('input');assert.equal(button(dialog,'保存').disabled,false);
  dialog.querySelector('form').dispatchEvent({type:'submit',preventDefault(){}});await settle();
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].endpoint,'adventure-save');assert.equal(f.writes[0].payload.name,'出发前');assert.equal(f.writes[0].payload.expectedVersion,7);
  assert.equal(document.body.querySelector('dialog'),null);assert.match(f.root.textContent,/已保存/);assert.equal(f.errors.length,0);
});

test('guest has no save controls; busy and expired views cannot send',async()=>{
  const guest=await ui({snapshot:{party:{isHost:false}},read:()=>assert.fail('guest must not list saves')});assert.equal(guest.root.querySelector('button'),null);
  const busy=await ui({read:async()=>({...list,canSave:false,reason:'正在结算'})});assert.equal(button(busy.root,'新建存档').disabled,true);assert.match(busy.root.textContent,/正在结算/);
  const stale=await ui();const old=button(stale.root,'新建存档');stale.ctx.snapshot={...snapshot,timelineId:'new',version:1};old.dispatchEvent('click');assert.equal(document.body.querySelector('dialog'),null);assert.equal(stale.writes.length,0);
});

test('disposed save list read cannot repaint or open old commands',async()=>{
  installDom();const root=document.createElement('main');let release;
  const loading=renderSaves(root,{snapshot,read:()=>new Promise(resolve=>release=resolve),hasPending:()=>false});
  root.dispatchEvent('dispose');const before=root.textContent;release(list);await loading;
  assert.equal(root.textContent,before);button(root,'新建存档').dispatchEvent('click');assert.equal(document.body.querySelector('dialog'),null);
});
