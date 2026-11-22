import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,settle} from './dom-shim.mjs';
import {renderMapReader} from '../src/map-reader.js';
installDom();
const map={id:'one',title:'原图',edition:'gm',status:'ready',width:20,height:30,importSource:{},grid:{uncalibrated:true}};
const button=(root,name)=>root.querySelectorAll('button').find(b=>(b.getAttribute('aria-label')||b.textContent)===name);
test('generated provenance remains schematic independently of calibration',async()=>{
  for(const uncalibrated of [true,false]){
    const root=document.createElement('div'),generated={...map,title:'扩展图',edition:'player',published:true,importSource:null,grid:{uncalibrated},provenance:{kind:'generated_schematic',referenceMode:'description'}};
    await renderMapReader(root,{snapshot:{party:{isHost:true}},read:async kind=>kind==='maps'?{maps:[generated]}:new Blob(['png'])});
    button(root,'扩展图').dispatchEvent('click');await settle();
    assert.match(root.textContent,/扩展示意 · 非原版地理/);assert.match(root.textContent,/文字风格参考（未上传原图）/);
    assert.equal(root.textContent.includes('比例未校准'),uncalibrated);root.dispatchEvent('dispose');
  }
});
test('host atlas reads metadata then selected authenticated bytes; never writes or generates',async()=>{
  const root=document.createElement('div'),reads=[];
  await renderMapReader(root,{snapshot:{party:{isHost:true}},read:async(kind,p)=>{reads.push({kind,p});return kind==='maps'?{maps:[map]}:new Blob(['png'],{type:'image/png'});},submit:()=>assert.fail('read only')});
  assert.deepEqual(reads.map(x=>x.kind),['maps']);assert.equal(button(root,'原始尺寸').hidden,true);
  button(root,'原图 · 仅主持').dispatchEvent('click');await settle();
  assert.deepEqual(reads[1],{kind:'map-image',p:{mapId:'one'}});assert.match(root.textContent,/主持版 · 不向玩家公开/);
  assert.equal(root.querySelectorAll('img').length,1);assert.equal(button(root,'原始尺寸').hidden,false);
  root.dispatchEvent('dispose');assert.equal(root.querySelectorAll('img').length,0);
});
test('guest cannot read atlas; stale selected images and disposed loads cannot reappear',async()=>{
  const guest=document.createElement('div');await renderMapReader(guest,{snapshot:{party:{isHost:false}},read:()=>assert.fail('host only')});
  const root=document.createElement('div');let resolve;
  await renderMapReader(root,{snapshot:{party:{isHost:true}},read:async kind=>kind==='maps'?{maps:[map]}:new Promise(r=>resolve=r)});
  button(root,'原图 · 仅主持').dispatchEvent('click');await settle();root.dispatchEvent('dispose');resolve(new Blob(['png']));await settle();
  assert.equal(root.querySelectorAll('img').length,0);
});
test('failed image clears old bytes and offers explicit retry, not a background loop',async()=>{
  const root=document.createElement('div');let calls=0;
  await renderMapReader(root,{snapshot:{party:{isHost:true}},read:async kind=>{if(kind==='maps')return {maps:[map]};calls++;throw Error('403');}});
  button(root,'原图 · 仅主持').dispatchEvent('click');await settle();assert.equal(calls,1);assert.match(root.textContent,/重新点击该地图重试/);
  assert.equal(root.querySelectorAll('img').length,0);assert.equal(button(root,'原始尺寸').hidden,true);
});
