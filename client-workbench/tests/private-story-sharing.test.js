import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
import {prepare,privateSourceKey,samePrivateSource,createApi} from '../src/api.js';
installDom();
const {storyMessages,createStoryFeed,renderStory}=await import('../src/story.js');
const source=n=>({kind:'event',id:'event-'+n,sequence:n,revision:'a'.repeat(64)});
const part=(n,actorId='self')=>({source:source(n),actorId,text:'你认得门口的人。',shared:false});
const snapshot=()=>({id:'campaign',version:4,party:{selfActorId:'self',isHost:false,members:[{id:'self',character:{name:'琳'}},{id:'other',character:{name:'梅拉'}}]},sharedStories:[]});
const row=(sequence,parts)=>({sequence,actorId:'self',privateParts:parts,narrative:'公共现场。'});

test('retelling sends only explicit words and exact source; legacy pending remains unchanged',async()=>{
  const prepared=prepare('story-share',{requestId:'r',source:{...source(1),text:'injected'},expectedVersion:4,text:'我只告诉队友这一句话。'});
  assert.deepEqual(prepared,{requestId:'r',source:source(1),text:'我只告诉队友这一句话。'});
  assert.deepEqual(prepare('story-share',{requestId:'legacy',source:source(1)}),{requestId:'legacy',source:source(1)});
  assert.equal(samePrivateSource(source(1),source(2)),false);
  let selected;const value=snapshot(),entry=row(1,[part(1),part(2,'other')]);
  const nodes=storyMessages(entry,value,[],null,undefined,s=>selected=s);
  const buttons=nodes.flatMap(n=>n.querySelectorAll('button[data-share-source]'));
  assert.equal(buttons.length,1);buttons[0].dispatchEvent({type:'click'});assert.deepEqual(selected.source,source(1));
  assert.equal(nodes.flatMap(n=>n.querySelectorAll('button[data-quick-share-source]')).length,1);
  value.party.selfActorId='host';value.party.isHost=true;
  const hostView=storyMessages(entry,value,[],null,undefined,()=>{});
  assert.equal(hostView.flatMap(n=>n.querySelectorAll('button')).length,0);
  assert.deepEqual(hostView.filter(n=>n.classList.contains('msg-private')).map(n=>n.querySelector('.secret-tag').textContent),['仅 琳 可见','仅 梅拉 可见'],'the host reads whose private line it is');
  const api=createApi({fetchImpl:async()=>new Response(JSON.stringify({snapshot:value,resolution:{kind:'story.share',status:'resolved'},replayed:false}),{status:200,headers:{'Content-Type':'application/json'}})});
  await assert.rejects(api.request('story-share',{baseUrl:'http://localhost:5180',campaignId:'campaign',accessToken:'fixture'},prepared),/响应不完整/);
});

test('same-version shares use numeric order and duplicate exact sources render once',async()=>{
  const value=snapshot();value.sharedStories=[10,2].map(n=>({sequence:n,atVersion:4,actorName:'琳',text:'公开-'+n,source:source(n)}));
  const ctx={snapshot:value,read:async(_,p)=>({nextAfter:p.through,hasMore:false,entries:[row(1,[part(1),part(2)]),row(3,[part(1)])]})};
  const feed=createStoryFeed(ctx,{isDisposed:()=>false});await feed.loadLatest(4);
  assert.equal(feed.element.querySelectorAll('.msg-private').length,2,'different source with identical text remains separate');
  assert.deepEqual(feed.element.querySelectorAll('.msg-group').map(n=>n.dataset.message).filter(k=>k.startsWith('shared:')),['shared:2','shared:10']);
});

test('opening is one public scene plus authorized supplements, and legacy acknowledgement survives the 100-item window',async()=>{
  const value=snapshot();value.opening={sceneId:'inn',publicText:'老板正在柜台后接待来客。',publicSequence:1,privateParts:[part(1)]};
  const acknowledged=new Set([privateSourceKey(source(1))]);
  const ctx={snapshot:value,sharedAcknowledgements:acknowledged,read:async(_,p)=>({nextAfter:p.through,hasMore:false,entries:[]})};
  const feed=createStoryFeed(ctx,{isDisposed:()=>false,sharePrivate:()=>assert.fail('legacy full share remains acknowledged')});await feed.loadLatest(4);
  assert.equal(feed.element.querySelectorAll('.msg-player').length,0);assert.equal(feed.element.querySelectorAll('.msg-private').length,1);
  const button=feed.element.querySelectorAll('button').find(n=>n.getAttribute('aria-label')==='已公开');assert.ok(button);assert.equal(button.hasAttribute('disabled'),true);assert.equal(button.textContent,'✓');
  value.sharedStories=Array.from({length:100},(_,i)=>({sequence:i+2,atVersion:4,actorName:'另一位',text:'较新的公开消息',source:source(i+2)}));
  feed.refreshShared();assert.equal(feed.element.querySelectorAll('button').find(n=>n.getAttribute('aria-label')==='已公开').hasAttribute('disabled'),true);
});

test('explicit recipients can retell separate parts, including host recipients; host read access alone cannot',()=>{
  const value=snapshot();value.party.isHost=true;
  const privateParts=[{...part(1,'other'),source:{...source(1),partId:'a'},canShare:true},
    {...part(1,'other'),source:{...source(1),partId:'b'},canShare:true},
    {...part(2,'other'),source:{...source(2),partId:'c'},canShare:false}];
  const nodes=storyMessages(row(1,privateParts),value,[],null,undefined,()=>{});
  assert.equal(nodes.filter(n=>n.classList.contains('msg-private')).length,3);
  assert.equal(nodes.flatMap(n=>n.querySelectorAll('button[data-share-source]')).length,2);
  assert.equal(nodes.flatMap(n=>n.querySelectorAll('button[data-quick-share-source]')).length,2);
  assert.notEqual(privateSourceKey(privateParts[0].source),privateSourceKey(privateParts[1].source));
});

test('empty-public opening opens an empty retelling editor; cancel writes nothing and different words keep the source available',async()=>{
  document.body.replaceChildren();const mount=document.createElement('div');document.body.append(mount);
  const value=snapshot(),message={...part(1,'other'),source:{...source(1),partId:'recipient-message'},canShare:true};
  value.opening={sceneId:'inn',publicText:'',publicSequence:1,privateParts:[message]};
  const sent=[];let pending=false,fail=false;
  const ctx={snapshot:value,hasPending:()=>pending,report:()=>{},read:async(_,p)=>({nextAfter:p.through,hasMore:false,entries:[]}),
    submit:async(key,request)=>{sent.push({key,...request});if(fail){pending=true;throw Error('response lost');}
      const share={sequence:sent.length,atVersion:4,actorName:'琳',publication:'retelling',text:request.text,source:request.source};value.sharedStories.push(share);return {sharedStory:share};}};
  const open=()=>{mount.querySelector('button[data-share-source]').dispatchEvent({type:'click'});return document.body.querySelector('dialog');};
  const fill=(dialog,text)=>{const input=dialog.querySelector('textarea');input.value=text;input.dispatchEvent({type:'input'});return dialog.querySelector('form');};
  try{
    await renderStory(mount,ctx);
    assert.equal(mount.querySelectorAll('.msg-dm').length,0);assert.equal(mount.querySelectorAll('.msg-private').length,1);
    let dialog=open();assert.equal(dialog.querySelector('textarea').value,'');
    assert.equal(dialog.querySelector('button[type="submit"]').hasAttribute('disabled'),true);
    fill(dialog,'这次不发送');dialog.querySelector('button[aria-label="关闭转述给队友"]').dispatchEvent({type:'click'});assert.equal(sent.length,0);
    dialog=open();assert.equal(dialog.querySelector('textarea').value,'');
    await fill(dialog,'  我认得那个人。\n先别惊动他。  ').onsubmit({preventDefault(){}});
    assert.equal(sent[0].text,'我认得那个人。\n先别惊动他。');assert.equal(sent[0].source.partId,message.source.partId);
    assert.equal(document.body.querySelector('dialog'),null);assert.match(mount.textContent,/转述给队伍/);assert.ok(mount.querySelector('button[data-share-source]'));
    dialog=open();await fill(dialog,'还有一件事。').onsubmit({preventDefault(){}});
    assert.equal(sent.length,2);assert.notEqual(sent[0].requestId,sent[1].requestId);
    dialog=open();fail=true;await fill(dialog,'响应丢失时只恢复这句话。').onsubmit({preventDefault(){}});
    fill(dialog,'不能绕过未确认请求。');assert.equal(dialog.querySelector('button[type="submit"]').disabled,true);
    await dialog.querySelector('form').onsubmit({preventDefault(){}});assert.equal(sent.length,3);
    mount.dispatchEvent(new Event('dispose'));assert.equal(document.body.querySelector('dialog'),null);
  }finally{mount.dispatchEvent(new Event('dispose'));}
});
