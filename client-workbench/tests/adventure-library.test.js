import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
import {renderAdventureLibrary} from '../src/adventure-library.js';
import {createApi,prepare,requestPath,versioned,seatMutations} from '../src/api.js';
installDom();
const entry={id:'rainbridge',name:'雨桥失信',version:'1.0.0',summary:'原创短篇',levels:'1级',duration:'1次',source:'原创',license:'本机',hash:'a'.repeat(64),sceneCount:5,mapCount:0};
function fixture(options={}){
  const root=document.createElement('div'),writes=[];
  const ctx={scope:'library',snapshot:{version:2,party:{isHost:true}},hasPending:()=>false,
    read:async()=>({adventures:[entry],canActivate:true,notice:'点击启用'}),
    submit:async(endpoint,payload)=>{writes.push({endpoint,payload});return {};},refresh:async()=>{},...options};
  return {root,ctx,writes};
}
const buttons=root=>root.querySelectorAll('button').filter(b=>b.textContent.startsWith('启用《'));
test('library adoption is one explicit click, freezes the package, and never sends author text',async()=>{
  const f=fixture();await renderAdventureLibrary(f.root,f.ctx);assert.equal(f.writes.length,0);
  buttons(f.root)[0].dispatchEvent('click');buttons(f.root)[0].dispatchEvent('click');await settle();
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].endpoint,'content/library/activate');
  assert.deepEqual(Object.keys(f.writes[0].payload).sort(),['expectedVersion','hash','libraryId','requestId']);
  assert.equal(f.writes[0].payload.hash,entry.hash);assert.equal(f.writes[0].payload.expectedVersion,2);
  assert.equal(document.body.querySelector('dialog'),null);assert.equal(buttons(f.root)[0].disabled,true);
});
test('guest and active campaigns have no replacement button; reading never writes',async()=>{
  const guest=fixture({snapshot:{version:2,party:{isHost:false}},read:()=>{throw Error('guest must not read');}});
  await renderAdventureLibrary(guest.root,guest.ctx);assert.equal(guest.root.textContent,'');
  const active=fixture({read:async()=>({adventures:[entry],canActivate:false,notice:'请新建房间'})});
  await renderAdventureLibrary(active.root,active.ctx);assert.equal(buttons(active.root).length,0);assert.match(active.root.textContent,/请新建房间/);assert.equal(active.writes.length,0);
});
test('stale, disposed and pending library choices cannot submit',async()=>{
  for(const change of [f=>f.ctx.snapshot.version++,f=>f.root.dispatchEvent('dispose'),f=>f.ctx.hasPending=()=>true]){
    const f=fixture();await renderAdventureLibrary(f.root,f.ctx);change(f);buttons(f.root)[0].dispatchEvent('click');await settle();assert.equal(f.writes.length,0);
  }
});
test('confirmed adoption stays settled after refresh failure and late responses respect disposal',async()=>{
  const f=fixture({refresh:async()=>{throw Error('offline');}});await renderAdventureLibrary(f.root,f.ctx);
  buttons(f.root)[0].dispatchEvent('click');await settle();assert.match(f.root.textContent,/已启用，但刷新失败/);
  buttons(f.root)[0].dispatchEvent('click');await settle();assert.equal(f.writes.length,1);
  let resolve;const late=fixture({read:()=>new Promise(r=>resolve=r)});const rendering=renderAdventureLibrary(late.root,late.ctx);
  late.root.dispatchEvent('dispose');resolve({adventures:[entry],canActivate:true,notice:'late'});await rendering;assert.equal(buttons(late.root).length,0);
});
test('library cards keep adventure choices without provenance controls or external DM tools',async()=>{
  const f=fixture();document.body.append(f.root);await renderAdventureLibrary(f.root,f.ctx);
  assert.equal(f.root.querySelectorAll('details').length,0);
  assert.equal(f.root.querySelectorAll('a').length,0);
  assert.doesNotMatch(f.root.textContent,/来源|版本|DM参考工具|2014|2024/);
  assert.equal(buttons(f.root).length,1);
  assert.equal(f.writes.length,0);f.root.dispatchEvent('dispose');assert.equal(document.body.querySelector('dialog'),null);f.root.remove();
});

test('library API uses original pending transport and rejects malformed successful bodies',async()=>{
  const session={campaignId:'room',accessToken:'fake',baseUrl:'http://localhost:5180'};
  assert.equal(requestPath('content/library/activate',session),'/api/v1/campaigns/room/content/library/activate');
  assert.ok(versioned.has('content/library/activate'));assert.ok(!seatMutations.has('content/library/activate'));
  assert.deepEqual(prepare('content/library/activate',{requestId:'r',expectedVersion:2,libraryId:entry.id,hash:entry.hash,prompt:'not sent'}),{requestId:'r',expectedVersion:2,libraryId:entry.id,hash:entry.hash});
  const api=createApi({fetchImpl:async()=>new Response(JSON.stringify({adventures:[{...entry,hash:''}],canActivate:true,notice:''}),{status:200,headers:{'content-type':'application/json'}})});
  await assert.rejects(()=>api.request('content/library',session));
});
