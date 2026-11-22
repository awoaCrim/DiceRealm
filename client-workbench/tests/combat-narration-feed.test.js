import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom} from './dom-shim.mjs';
installDom();
const {createStoryFeed}=await import('../src/story.js');

test('same-input beats keep their own prose; failed final read retries at the same version before battle publication',async()=>{
 const snapshot={id:'room',version:8,party:{isHost:false,members:[]}},loaded=[];
 let fail=true,reads=0;
 const entries=[{sequence:2,actionId:'same',actorId:'p',origin:{input:'守住这里'},narrative:'第一位敌人上前。'},
  {sequence:5,continuationOf:2,actionId:'same',actorId:'p',narrative:'第二位敌人绕到侧面。'}];
 const feed=createStoryFeed({snapshot,read:async()=>{reads++;if(fail)throw new Error('临时读取失败');return {entries,nextAfter:8,hasMore:false};}},
  {isDisposed:()=>false,onLoaded:v=>{assert.match(feed.element.textContent,/第一位敌人上前/);assert.match(feed.element.textContent,/第二位敌人绕到侧面/);loaded.push(v);}});
 await feed.loadLatest(8);assert.equal(feed.loadedVersion(),0);assert.deepEqual(loaded,[]);
 assert.match(feed.element.textContent,/临时读取失败/);
 fail=false;await feed.loadLatest(8);assert.equal(feed.loadedVersion(),8);assert.deepEqual(loaded,[8]);
 assert.equal(feed.element.textContent.split('守住这里').length-1,1);
 assert.equal(feed.element.textContent.split('第一位敌人上前。').length-1,1);
 assert.equal(feed.element.textContent.split('第二位敌人绕到侧面。').length-1,1);
 await feed.loadLatest(8);assert.equal(reads,2);assert.deepEqual(loaded,[8]);
});
