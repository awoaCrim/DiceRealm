import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom} from './dom-shim.mjs';
installDom();
const {h}=await import('../src/dom.js');
const {createReveal}=await import('../src/story-reveal.js');
const {createStoryFeed}=await import('../src/story.js');

// A manual clock: each scheduled step runs only when the test says so, and reports its delay.
function clock(){
  const queue=[];
  return {schedule:(fn,ms)=>{queue.push({fn,ms});return queue.length;},cancel:()=>{queue.length=0;},
    step(){const next=queue.shift();if(!next)return null;next.fn();return next.ms;},get pending(){return queue.length;}};
}
const message=(...parts)=>h('div.msg.msg-dm.msg-narrative',{},h('div.msg-c',{},h('p',{},...parts.map(text=>h('span',{},text)))));
const shown=node=>[...node.querySelectorAll('span')].filter(s=>!s.classList.contains('reveal-rest'))
  .map(s=>s.textContent.slice(0,s.textContent.length-(s.querySelector('.reveal-rest')?.textContent.length||0))).join('');

test('narration is laid out whole and revealed a character at a time, pausing at punctuation',()=>{
  const time=clock();let done=0;
  const reveal=createReveal({...time,onDone:()=>done++});
  const node=message('雨停了。','「走吧」');
  reveal.add('a');reveal.attach('a',node);
  // Nothing is shown yet, but every character is in place (the rest is only invisible).
  assert.equal(shown(node),'');assert.equal(node.textContent,'雨停了。「走吧」');
  for(let i=0;i<3;i++)time.step();
  assert.equal(shown(node),'雨停了');
  time.step();assert.equal(shown(node),'雨停了。');
  // The step after the full stop waited longer than the one after an ordinary character.
  const afterStop=time.step(),afterChar=time.step();
  assert.equal(afterStop>afterChar,true,'a full stop pauses longer than a character');
  while(time.pending)time.step();
  assert.equal(shown(node),'雨停了。「走吧」');assert.equal(node.querySelector('.reveal-rest'),null);assert.equal(done,1);
});

test('a label stays as it is; only the text after it is revealed',()=>{
  const time=clock(),reveal=createReveal(time);
  const node=h('div.msg.msg-private',{},h('div.msg-c',{},h('p',{},h('span.secret-tag',{},'仅你可见'),h('span',{},'钥匙。'))));
  reveal.add('p');reveal.attach('p',node);time.step();
  assert.equal(node.querySelector('.secret-tag').textContent,'仅你可见');
  assert.equal(node.querySelector('.secret-tag').querySelector('.reveal-rest'),null);
  assert.equal(node.querySelectorAll('.reveal-rest')[0].textContent,'匙。');
});

test('a redraw continues the reveal on the new node; finish shows everything; a second message waits its turn',()=>{
  const time=clock();
  const reveal=createReveal(time);
  reveal.add('a');reveal.attach('a',message('第一段。'));
  reveal.add('b');const second=message('第二段。');reveal.attach('b',second);
  time.step();time.step();
  const redrawn=message('第一段。');reveal.attach('a',redrawn);
  assert.equal(shown(redrawn),'第一');assert.equal(shown(second),'','the next message stays hidden until the first is done');
  assert.equal(reveal.finish(),true);
  assert.equal(shown(redrawn),'第一段。');assert.equal(shown(second),'第二段。');
  assert.equal(reveal.active(),false);assert.equal(reveal.finish(),false,'nothing left to finish');
});

test('the player feed reveals only narration that arrives live; history and the host workbench show it whole',async()=>{
  const snapshot={id:'room',version:3,party:{isHost:false,selfActorId:'p',members:[]}};
  let entries=[{sequence:1,actionId:'a1',actorId:'p',narrative:'旧的旁白。'}];
  const feed=(player)=>createStoryFeed({snapshot,read:async()=>({entries,nextAfter:snapshot.version,hasMore:false})},{isDisposed:()=>false,player});
  const page=feed(true),host=feed(false);
  await page.loadLatest(3,{live:false});await host.loadLatest(3,{live:false});
  assert.equal(page.element.querySelector('.reveal-rest'),null,'history is not revealed again');
  entries=[...entries,{sequence:4,actionId:'a2',actorId:'p',narrative:'新的旁白到了。'}];snapshot.version=4;
  await page.loadLatest(4);await host.loadLatest(4);
  assert.ok(page.element.querySelector('.reveal-rest'),'new narration starts hidden on the player page');
  assert.equal(host.element.querySelector('.reveal-rest'),null,'the workbench shows it whole');
  assert.equal(page.finishReveal(),true);
  assert.equal(page.element.querySelector('.reveal-rest'),null);
  assert.match(page.element.textContent,/新的旁白到了。/);
});
