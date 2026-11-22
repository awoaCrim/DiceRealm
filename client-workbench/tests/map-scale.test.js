import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
import {renderMapReader,confirmMapGridDraft,gridScaleText} from '../src/map-reader.js';
import {prepare,createApi} from '../src/api.js';
import {renderMapsPage} from '../src/content-page.js';
import {readDraft,draftKey} from '../src/drafts.js';
installDom();
const button=(r,name)=>r.querySelectorAll('button').find(b=>(b.getAttribute('aria-label')||b.textContent)===name);
const input=(r,label)=>r.querySelector(`[aria-label="${label}"]`);
const select=(r,label)=>r.querySelectorAll('label').find(l=>l.querySelector('span')?.textContent===label)?.querySelector('select');
const change=(el,value)=>{el.value=String(value);el.dispatchEvent('input');el.dispatchEvent('change');};
const click=async(r,name)=>{assert.ok(button(r,name),name);button(r,name).dispatchEvent('click');await settle();};
const base={id:'one',title:'局部图',version:3,edition:'player',published:true,status:'ready',imageUrl:'/image',width:1000,height:600,currentScene:true,purpose:'tactical',grid:{type:'square',cellPixels:100,distance:10,offsetX:7,offsetY:9,units:'feet',scaleBasis:{kind:'source',detail:'原图每格10尺'}}};
async function mount(options={}){
 const root=document.createElement('div'),scope=crypto.randomUUID();
 const ctx={scope,snapshot:{version:12,party:{isHost:true}},read:async k=>k==='maps'?{maps:[base],selectedMapId:'other'}:new Blob(['png']),refresh:async()=>{},...options};
 await renderMapReader(root,ctx);await click(root,'局部图');
 const img=root.querySelector('img');if(img)img.getBoundingClientRect=()=>({left:20,top:10,width:500,height:300});
 return {root,ctx,key:draftKey(ctx.scope,'map-grid:one')};
}
test('scale text refuses unknown, missing units and missing values',()=>{
 assert.match(gridScaleText({...base.grid,units:''}),/未记录/);
 assert.match(gridScaleText({...base.grid,scaleBasis:{kind:'unknown'}}),/禁止精确测距/);
 assert.match(gridScaleText(base.grid),/100 像素 = 10 英尺/);
});
test('two rendered points use natural pixels, preserve original grid and offset, and serialize only wire fields',async()=>{
 let sent;
 const {root}=await mount({submit:async(k,p)=>{sent={k,p};}});
 assert.equal(select(root,'网格类型').value,'square');
 await click(root,'在图上取点');
 root.querySelector('img').dispatchEvent({type:'click',clientX:70,clientY:60});
 root.querySelector('img').dispatchEvent({type:'click',clientX:170,clientY:60});
 assert.equal(root.querySelectorAll('circle').length,2);assert.equal(root.querySelector('line').getAttribute('x2'),'300');
 change(input(root,'两点间实际长度'),40);await click(root,'按两点计算比例');
 assert.equal(input(root,'每格实际距离').value,'20');assert.equal(input(root,'每格像素').value,'100');
 await click(root,'保存用途与比例尺');assert.equal(sent.k,'maps-grid');
 assert.equal(sent.p.grid.offsetX,7);assert.equal(sent.p.grid.offsetY,9);assert.equal(sent.p.expectedVersion,3);
 const wire=prepare(sent.k,sent.p);assert.equal(wire.mapDraftRevision,undefined);assert.equal(wire.purpose,'tactical');assert.equal(wire.grid.distance,20);
 root.dispatchEvent('dispose');
});
test('unknown basis stays uncalibrated; no grid calibration rescales short spans without guessing',async()=>{
 const map={...base,grid:{...base.grid,type:'none',uncalibrated:true,scaleBasis:{kind:'unknown',detail:'缺少原图说明'}}};
 const {root}=await mount({read:async k=>k==='maps'?{maps:[map]}:new Blob(['png'])});
 await click(root,'在图上取点');root.querySelector('img').dispatchEvent({type:'click',clientX:20,clientY:10});root.querySelector('img').dispatchEvent({type:'click',clientX:24,clientY:10});
 change(input(root,'两点间实际长度'),2);await click(root,'按两点计算比例');assert.match(root.textContent,/不能标为已校准/);
 change(select(root,'比例依据'),'dm');await click(root,'按两点计算比例');
 assert.equal(input(root,'每格像素').value,'16');assert.equal(input(root,'每格实际距离').value,'4');assert.equal(input(root,'标为未校准').checked,false);
 root.dispatchEvent('dispose');
});
test('late save confirmation preserves newer draft and retired editor cannot submit or revive it',async()=>{
 let complete,sent,calls=0;
 const other={...base,id:'two',title:'城镇图',purpose:'settlement'};
 const {root,ctx,key}=await mount({read:async k=>k==='maps'?{maps:[base,other]}:new Blob(['png']),submit:async(k,p)=>{calls++;sent=p;await new Promise(r=>complete=r);}});
 const old=input(root,'比例依据说明'),oldSave=button(root,'保存用途与比例尺');change(old,'第一稿');oldSave.dispatchEvent('click');await settle();
 change(old,'较晚输入');const newer=readDraft(key);assert.notEqual(JSON.parse(newer).revision,sent.mapDraftRevision);
 await click(root,'城镇图');oldSave.dispatchEvent('click');change(old,'旧组件事件');assert.equal(readDraft(key),newer);assert.equal(calls,1);
 complete();await settle();assert.equal(readDraft(key),newer);assert.match(root.querySelector('img').getAttribute('alt'),/城镇图/);
 confirmMapGridDraft(ctx.scope,sent);assert.equal(readDraft(key),newer);root.dispatchEvent('dispose');
});
test('global original-request success clears only matching draft even after local failure and refresh failure',async()=>{
 let payload;
 const {root,ctx,key}=await mount({submit:async(k,p)=>{payload=p;throw Error('response lost');}});
 const old=input(root,'比例依据说明');change(old,'原请求');await click(root,'保存用途与比例尺');assert.ok(readDraft(key));
 confirmMapGridDraft('other-scope',payload);assert.ok(readDraft(key));
 confirmMapGridDraft(ctx.scope,payload);assert.equal(readDraft(key),'');
 change(old,'迟到旧事件');assert.equal(readDraft(key),'');root.dispatchEvent('dispose');
});
test('stale draft retains base version until explicit discard; map selection uses both map and game versions',async()=>{
 let list=base;const writes=[];
 const {root}=await mount({read:async k=>k==='maps'?{maps:[list]}:new Blob(['png']),submit:async(k,p)=>{writes.push({k,p});if(k==='maps-grid')throw Error('version conflict');}});
 change(input(root,'比例依据说明'),'冻结旧稿');list={...base,version:4};await click(root,'重新读取图册');
 assert.match(root.textContent,/基于地图版本 3/);await click(root,'保存用途与比例尺');assert.equal(writes[0].p.expectedVersion,3);
 await click(root,'放弃草稿并载入当前记录');assert.equal(input(root,'比例依据说明').value,'原图每格10尺');
 await click(root,'设为当前地图');assert.equal(writes[1].k,'maps-select');assert.equal(writes[1].p.expectedMapVersion,4);assert.equal(writes[1].p.expectedVersion,12);
 root.dispatchEvent('dispose');
});
test('real map page forwards disposal to its reader: no late image or selection refresh',async()=>{
 for(const phase of ['image','selection']){
  const root=document.createElement('div');let finish,refreshes=0;
  await renderMapsPage(root,{scope:crypto.randomUUID(),snapshot:{version:12,party:{isHost:true}},
   read:async k=>k==='maps'?{maps:[base]}:phase==='image'?new Promise(r=>finish=r):new Blob(['png']),
   submit:async()=>new Promise(r=>finish=r),refresh:async()=>{refreshes++;}});
  await click(root,'局部图');
  if(phase==='selection')await click(root,'设为当前地图');
  root.dispatchEvent(new Event('dispose'));finish(new Blob(['png']));await settle();
  assert.equal(root.querySelectorAll('img').length,0);assert.equal(refreshes,0);
 }
});
test('select request validates the returned map identity and serializes the two versions',async()=>{
 let request;
 const api=createApi({fetchImpl:async(url,options)=>{request={url,body:JSON.parse(options.body)};return new Response(JSON.stringify({version:13,selectedMapId:'different',replayed:false}),{headers:{'Content-Type':'application/json'}});}});
 await assert.rejects(api.request('maps-select',{campaignId:'campaign',accessToken:'test'},{mapId:'one',requestId:'id',expectedVersion:12,expectedMapVersion:3}),/结果仍未确认/);
 assert.match(request.url,/maps\/one\/select$/);assert.deepEqual(request.body,{requestId:'id',expectedVersion:12,expectedMapVersion:3});
});
