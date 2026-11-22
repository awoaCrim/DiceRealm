import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom} from './dom-shim.mjs';
import {h,confirmDialog} from '../src/dom.js';
import {setupTopbarPanels} from '../src/topbar.js';

const click=element=>element.dispatchEvent({type:'click'});
test('only the explicit confirmation accepts; × and native dismissal restore the opener',async()=>{
  const doc=installDom();let restored=0;
  doc.activeElement={isConnected:true,focus(){restored++;}};
  const declined=confirmDialog({title:'确认外发？',confirmText:'确认外发',lines:['可能产生费用']});
  let dialog=doc.body.querySelector('dialog');
  assert.equal(dialog.querySelector('.close-button').textContent,'×');
  assert.equal(dialog.querySelector('.close-button').getAttribute('aria-label'),'关闭确认');
  const firstTitle=dialog.getAttribute('aria-labelledby');
  click(dialog.querySelector('.close-button'));
  assert.equal(await declined,false);assert.equal(restored,1);
  const escaped=confirmDialog({title:'确认启用？'});
  dialog=doc.body.querySelector('dialog');
  assert.notEqual(dialog.getAttribute('aria-labelledby'),firstTitle);
  dialog.close();assert.equal(await escaped,false);assert.equal(restored,2);
  const accepted=confirmDialog({title:'确认发布？',confirmText:'确认发布'});
  click(doc.body.querySelector('.btn-primary'));
  assert.equal(await accepted,true);assert.equal(restored,3);
  assert.equal(doc.body.querySelector('dialog'),null);
});

test('topbar panels are exclusive and one Escape dismisses only the current non-modal layer',()=>{
  const doc=installDom(),panels={};let keydown;
  for(const [id,title] of [['reading-controls','阅读与操作'],['account-controls','账户菜单']]){
    const body=h('div.topbar-panel');body.prepend=element=>{body.children.unshift(element);};
    const summary=h('summary',{'aria-label':title},title);summary.focus=()=>{doc.activeElement=summary;};
    if(id==='account-controls')body.append(h('button.btn',{},'我的战役'));
    panels[id]=h('details',{id},summary,body);
  }
  doc.getElementById=id=>panels[id];doc.addEventListener=(event,handler)=>{if(event==='keydown')keydown=handler;};
  let modal=false;doc.querySelector=()=>modal?{}:null;
  setupTopbarPanels(doc);
  const reading=panels['reading-controls'],connection=panels['account-controls'];
  reading.open=true;reading.dispatchEvent({type:'toggle'});
  connection.open=true;connection.dispatchEvent({type:'toggle'});assert.equal(reading.open,false);
  click(connection.querySelector('.close-button'));assert.equal(connection.open,false);
  assert.equal(doc.activeElement,connection.querySelector('summary'));
  reading.open=true;
  const event={key:'Escape',preventDefault(){this.prevented=true;}};
  modal=true;keydown(event);assert.equal(reading.open,true);
  modal=false;keydown({...event,isComposing:true});assert.equal(reading.open,true);
  keydown(event);assert.equal(reading.open,false);assert.equal(event.prevented,true);
  assert.equal(doc.activeElement,reading.querySelector('summary'));
  connection.open=true;click(connection.querySelector('.btn'));
  assert.equal(connection.open,false,'account action dismisses its menu');
  assert.equal(doc.activeElement,connection.querySelector('summary'));
});
