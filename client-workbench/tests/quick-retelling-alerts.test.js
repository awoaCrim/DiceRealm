import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
import {prepare,createApi} from '../src/api.js';
installDom();
const {renderStory,storyMessages,createStoryFeed}=await import('../src/story.js');
const source={kind:'event',id:'private-event',sequence:1,revision:'a'.repeat(64)};
const snapshot=()=>({id:'campaign',version:4,party:{selfActorId:'self',isHost:false,members:[{id:'self',character:{name:'琳'}}]},sharedStories:[],opening:{publicSequence:1,publicText:'',privateParts:[{actorId:'self',source,canShare:true,text:'可能有人在北坡，尚未确认。'}]}});

test('quick retelling is one direct submit without a dialog or source text, blocks duplicate clicks and publishes the receipt',async()=>{
  document.body.replaceChildren();const mount=document.createElement('div');document.body.append(mount);
  const value=snapshot(),sent=[];let release;
  const ctx={snapshot:value,hasPending:()=>false,report:()=>{},read:async(_,p)=>({nextAfter:p.through,hasMore:false,entries:[]}),
    submit:async(key,request)=>{sent.push({key,...request});await new Promise(resolve=>release=resolve);
      const sharedStory={sequence:1,atVersion:4,actorId:'self',actorName:'琳',publication:'retelling',source,text:'北坡可能有人，我还不能确定。'};
      value.sharedStories.push(sharedStory);return {sharedStory};}};
  try{
    await renderStory(mount,ctx);const button=mount.querySelector('button[data-quick-share-source]');assert.ok(button);
    assert.equal(button.textContent,'↗');assert.equal(button.getAttribute('aria-label'),'快速转述');
    const manual=mount.querySelector('button[data-share-source]');assert.equal(manual.textContent,'✎');assert.equal(manual.getAttribute('aria-label'),'手写转述');
    assert.equal(button.parentNode.classList.contains('msg-share-row'),true);
    button.dispatchEvent({type:'click'});button.dispatchEvent({type:'click'});
    assert.equal(document.body.querySelector('dialog'),null);assert.equal(sent.length,1);
    assert.equal(sent[0].quick,true);assert.deepEqual(sent[0].source,source);assert.equal('text' in sent[0],false);
    release();await settle();assert.match(mount.textContent,/北坡可能有人，我还不能确定/);
    assert.ok(mount.querySelector('button[data-share-source]'),'manual mode remains available');
  }finally{mount.dispatchEvent(new Event('dispose'));}
});

test('quick wire accepts only same actor/source generated retelling and leaves legacy requests unchanged',async()=>{
  const request=prepare('story-share',{requestId:'quick',source,quick:true});assert.deepEqual(request,{requestId:'quick',source,quick:true});
  assert.throws(()=>prepare('story-share',{requestId:'quick',source,quick:true,text:'mixed'}));
  assert.equal('quick' in prepare('story-share',{requestId:'legacy',source}),false);
  const value=snapshot(),receipt={snapshot:value,replayed:false,resolution:{kind:'story.share',status:'resolved'},sharedStory:{sequence:1,actorId:'self',source,publication:'retelling',text:'生成文字'}};
  const api=createApi({fetchImpl:async()=>new Response(JSON.stringify(receipt),{status:200,headers:{'Content-Type':'application/json'}})});
  const session={baseUrl:'http://localhost:5180',campaignId:'campaign',accessToken:'fixture'};
  assert.equal((await api.request('story-share',session,request)).sharedStory.text,'生成文字');
  for(const change of [{actorId:'other'},{source:{...source,sequence:2}},{publication:undefined},{text:''}]){
    const original={...receipt.sharedStory};Object.assign(receipt.sharedStory,change);
    await assert.rejects(api.request('story-share',session,request));receipt.sharedStory=original;
  }
});

test('combat details retain expansion and summary focus through background redraws',async()=>{
  document.body.replaceChildren();const value=snapshot();value.opening=null;
  const entry={sequence:2,actorId:'self',narrativeSource:'harness',narrative:'已保存叙述',initialResult:{combatLog:[{sequence:1,kind:'damage',presentation:{combatId:'battle',text:'受到6点伤害'}}]}};
  const ctx={snapshot:value,read:async(_,p)=>({nextAfter:p.through,hasMore:false,entries:[entry]})};
  const feed=createStoryFeed(ctx,{isDisposed:()=>false});document.body.append(feed.element);await feed.loadLatest(4);
  let details=feed.element.querySelector('.msg-combat-details');details.open=true;details.querySelector('summary').focus();
  feed.refreshShared();details=feed.element.querySelector('.msg-combat-details');assert.equal(details.open,true);
  assert.equal(document.activeElement,details.querySelector('summary'));
  details.open=false;feed.updateProgress([]);assert.equal(feed.element.querySelector('.msg-combat-details').open,false);
});

test('only same activity harness prose folds combat records, and missing narration keeps the fallback',()=>{
  const value=snapshot();value.opening=null;
  const event={sequence:7,round:1,kind:'damage',actorId:'self',text:'audit',presentation:{combatId:'battle',text:'琳受到6点伤害。'}};
  const entry={sequence:2,actorId:'self',narrativeSource:'harness',narrative:'箭矢命中，你受了伤。',initialResult:{combatLog:[event]}};
  const nodes=storyMessages(entry,value),details=nodes.find(n=>n.classList.contains('msg-combat-details'));
  assert.ok(details);assert.equal(details.hasAttribute('open'),false);assert.match(details.textContent,/6点伤害/);
  assert.ok(nodes.indexOf(details)>nodes.findIndex(n=>n.classList.contains('msg-dm')));
  for(const change of [{narrative:''},{narrativeSource:'system'}]){
    const fallback=storyMessages({...entry,...change},value);assert.equal(fallback.some(n=>n.classList.contains('msg-combat-details')),false);
    assert.ok(fallback.some(n=>n.textContent.includes('6点伤害')));
  }
});

test('a player who entered after the shared opening appears in their own public arrival line',async()=>{
  document.body.replaceChildren();const mount=document.createElement('div');document.body.append(mount);
  const value=snapshot();
  value.opening={publicSequence:1,publicText:'暮雨敲着驿站的屋檐。',privateParts:[],arrivals:[{actorId:'other',sequence:3,text:'周岩跨进门来，身上带着外头的雨气。'}]};
  const ctx={snapshot:value,hasPending:()=>false,report:()=>{},read:async(_,p)=>({nextAfter:p.through,hasMore:false,entries:[]}),submit:async()=>({})};
  try{
    await renderStory(mount,ctx);
    assert.deepEqual([...mount.querySelectorAll('.msg-narrative')].map(n=>n.textContent.trim()),['暮雨敲着驿站的屋檐。','周岩跨进门来，身上带着外头的雨气。']);
  }finally{mount.dispatchEvent(new Event('dispose'));}
});
