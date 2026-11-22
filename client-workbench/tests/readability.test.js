import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeReadability,setupReadability} from '../src/readability.js';
test('display choices directly select a scale and persist only local preferences',()=>{
  assert.deepEqual(normalizeReadability({scale:900,reducedMotion:'true'}),{scale:100,reducedMotion:false});
  const controls={'text-size':{},'reduce-motion':{}};const doc={documentElement:{dataset:{}},getElementById:id=>controls[id]};
  const writes=[];const storage={getItem:()=>' {"scale":125,"reducedMotion":true}',setItem:(...v)=>writes.push(v)};
  setupReadability(doc,storage);assert.equal(doc.documentElement.dataset.uiScale,'125');
  assert.equal(controls['text-size'].value,'125');assert.equal(controls['reduce-motion'].checked,true);
  controls['text-size'].value='100';controls['text-size'].onchange();assert.equal(doc.documentElement.dataset.uiScale,'100');
  controls['text-size'].value='150';controls['text-size'].onchange();assert.equal(doc.documentElement.dataset.uiScale,'150');
  controls['text-size'].value='900';controls['text-size'].onchange();assert.equal(controls['text-size'].value,'100');
  controls['reduce-motion'].checked=false;controls['reduce-motion'].onchange();assert.equal(doc.documentElement.dataset.reduceMotion,'false');
  assert.ok(writes.every(([key])=>key==='dicerealm.display.v1'));
});
test('unavailable preference storage cannot block rendering',()=>{
  const controls={'text-size':{},'reduce-motion':{}};const doc={documentElement:{dataset:{}},getElementById:id=>controls[id]};
  setupReadability(doc,{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}});
  assert.equal(doc.documentElement.dataset.uiScale,'100');assert.doesNotThrow(()=>controls['text-size'].onchange());
});
