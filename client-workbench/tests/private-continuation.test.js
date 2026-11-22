import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom} from './dom-shim.mjs';
installDom();
const {createStoryFeed}=await import('../src/story.js');

test('public continuations render independently without a private root or invented player speech',async()=>{
  const entries=[3,4].map(sequence=>({sequence,actorId:'other',actionId:'private-action',continuationOf:2,
    origin:{input:'',label:''},narrative:'公开结果 '+sequence,narrativeSource:'harness',status:'completed'}));
  const ctx={snapshot:{id:'c',version:4,party:{selfActorId:'self',isHost:false,members:[]},sharedStories:[]},
    read:async()=>({entries,nextAfter:4,hasMore:false})};
  const feed=createStoryFeed(ctx,{isDisposed:()=>false});await feed.loadLatest(4);
  assert.equal(feed.element.querySelectorAll('.msg-player').length,0);
  assert.deepEqual(feed.element.querySelectorAll('.msg-dm').map(n=>n.textContent.includes('公开结果')), [true,true]);
  assert.deepEqual(feed.element.querySelectorAll('.msg-group').map(n=>n.dataset.message),['entry:3','entry:4']);
});
