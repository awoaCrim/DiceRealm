// The card over the map: consent opens the roll, closing never cancels, results are skippable,
// and the choice card offers only what the server says is available.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom} from './dom-shim.mjs';

installDom();
const {createCard}=await import('../src/play/card.js');

function setup(){
  const host=document.createElement('div'),calls=[];
  const card=createCard(host,{onRoll:()=>calls.push('roll'),onCancelRoll:()=>calls.push('cancel-roll'),onChoose:id=>calls.push('choose:'+id),
    onRuling:()=>calls.push('ruling'),onCancelIntent:()=>calls.push('cancel-intent'),onSelect:id=>calls.push('select:'+id)});
  return {host,card,calls};
}
// The shim keeps h()'s disabled as an attribute; a browser reflects it to the property.
const disabled=el=>el.disabled||el.getAttribute('disabled')!==null;
const roll={id:'r',label:'行动检定',description:'门框碎石松动',preview:{ability:'strength',skill:'Athletics',testKind:'ability',modifier:5,mode:'normal',hasDc:true,dc:15}};

test('the roll card asks for consent and closing it is not cancelling',()=>{
  const {host,card,calls}=setup();
  card.show({kind:'roll',roll,ready:true,busy:false,note:''});
  assert.doesNotMatch(host.textContent,/null|undefined/,'absent parts leave no text behind');
  assert.match(host.textContent,/难度15/);assert.match(host.textContent,/加值\+5/);
  assert.equal(card.space(),true);assert.deepEqual(calls,['roll'],'Space rolls while consent is open');
  card.show({kind:'roll',roll,ready:false,busy:false,note:'情况已变化'});
  assert.equal(disabled(host.querySelector('.pl-roll-btn')),true);assert.match(host.textContent,/情况已变化/);
  assert.equal(card.space(),false,'a stale roll is never rolled by a key');
  host.querySelector('.pl-card-link').dispatchEvent('click');assert.deepEqual(calls,['roll','cancel-roll'],'it can still be cancelled');
  card.hide();assert.equal(card.view,null);assert.equal(calls.length,2,'closing sends nothing');
});

test('a recorded result is shown at once for a replay and Space closes it',()=>{
  const {host,card}=setup();
  card.show({kind:'result',live:false,check:{ability:'strength',skill:'Athletics',testKind:'ability',rolls:[14],selected:14,modifier:5,total:19,hasDc:true,dc:15,success:true,mode:'normal'}});
  assert.match(host.querySelector('.pl-kicker').textContent,/成功/);
  assert.equal(host.querySelector('.pl-eq').children.at(-1).textContent,'19');
  assert.equal(host.querySelector('.pl-stamp').classList.contains('is-on'),true);
  assert.equal(card.space(),true);assert.equal(card.view,null);
});

test('the choice card offers only available options and hands the choice back',()=>{
  const {host,card,calls}=setup();
  const intent={id:'i',question:'用哪一种方式？',text:'我想开门',options:[{id:'a',label:'撬锁',details:{cost:'1 次'}},{id:'b',label:'施法',details:{unavailableReason:'法术位不足'}}]};
  card.show({kind:'intent',intent,canChoose:true,busy:false,note:''});
  const [pick,blocked]=host.querySelectorAll('.pl-option');
  assert.equal(disabled(pick),false);assert.equal(disabled(blocked),true);assert.match(blocked.textContent,/法术位不足/);
  pick.dispatchEvent('click');
  card.show({kind:'intent',intent,canChoose:false,busy:false,note:'情况已变化'});
  const [cancel,ruling]=host.querySelectorAll('.pl-card-link');
  assert.equal(disabled(ruling),true,'only cancel is left once the choice is stale');
  cancel.dispatchEvent('click');
  assert.deepEqual(calls,['choose:a','cancel-intent']);
});
