// Plays /play/ in headless Chrome over the DevTools protocol (Node 22, no packages): connect as the
// fixture guest, send an action, consent to the roll, skip the result with Space, wait for the
// narration, and save screenshots at 1920x1080 and 1440x900. Console errors are reported.
// With --join the player is new instead: room number and password, the full builder (human sage
// wizard), the join, the host's approval, then the same action flow. With --combat (the
// --play-combat-browser fixture) the player asks for the fight, consents to initiative, steps on the
// map grid, attacks a chosen target, ends the turn and reviews Second Wind before using it. With
// --wizard (the same fixture started with "wizard") the caster allocates and casts Magic Missile,
// passes on Shield, drops to 0 HP and makes death saves until a natural 20 brings her back. With
// --caster (the fixture started with "caster") she concentrates on Blade Ward, holds it through a
// hit, then places Acid Splash on the map over herself and the guard, makes her own save and loses
// the concentration.
// --party (the fixture started with "party") opens a second page in its own browser context for the
// guest seat: both consent to initiative, the host's Acid Splash catches the guest, whose own save
// comes to the guest's page, and the guest attacks in its own turn.
// Usage: node scripts/qa/play-tour.mjs <fixture state.json> <outDir> [--join|--combat|--wizard|--caster|--party]; see scripts/qa/README.md.
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// PLAY_TOUR_SIZE=1680x817 tours at another window size (default 1920x1080).
const [stateFile,out,mode]=process.argv.slice(2),[width,height]=(process.env.PLAY_TOUR_SIZE||'1920x1080').split('x').map(Number);
// The fixture writes its state file once the guest seat is ready.
for(let i=0;i<240&&!existsSync(stateFile);i++)await new Promise(r=>setTimeout(r,500));
const state=JSON.parse(readFileSync(stateFile,'utf8'));
mkdirSync(out,{recursive:true});
const chrome=process.env.CHROME||process.env.HOME+'/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const port=9300+Math.floor(Math.random()*500);
const proc=spawn(chrome,['--headless','--no-sandbox','--disable-gpu','--remote-debugging-port='+port,'--user-data-dir='+mkdtempSync(join(tmpdir(),'play-tour-')),'--no-first-run','--hide-scrollbars','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let targets;
for(let i=0;i<50;i++){try{targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();break;}catch{await sleep(200);}}
// One DevTools connection per page; the helpers below act on the current `page`.
const sockets=[],problems=[];
async function connect(url,tag=''){
  const ws=new WebSocket(url);sockets.push(ws);
  await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const waiting=new Map(),mark=text=>problems.push((tag?tag+' ':'')+text);
  ws.addEventListener('message',event=>{
    const msg=JSON.parse(event.data);
    if(msg.id&&waiting.has(msg.id)){const {resolve,reject}=waiting.get(msg.id);waiting.delete(msg.id);msg.error?reject(new Error(msg.error.message)):resolve(msg.result);}
    if(msg.method==='Runtime.exceptionThrown')mark('exception: '+(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text));
    if(msg.method==='Runtime.consoleAPICalled'&&['error','warning'].includes(msg.params.type))mark('console.'+msg.params.type+': '+msg.params.args.map(a=>a.value??a.description).join(' '));
    if(msg.method==='Log.entryAdded'&&['error','warning'].includes(msg.params.entry.level))mark('log: '+msg.params.entry.text+' '+(msg.params.entry.url||''));
  });
  return {tag,send:(method,params={})=>new Promise((resolve,reject)=>{const n=++id;waiting.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));})};
}
let page=await connect(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
const send=(method,params)=>page.send(method,params);
// A second seat needs its own storage: a fresh browser context, so its saved seat is not the first one's.
async function newPage(tag){
  const browser=await connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl,'browser');
  const {browserContextId}=await browser.send('Target.createBrowserContext');
  const {targetId}=await browser.send('Target.createTarget',{url:'about:blank',browserContextId});
  const list=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return connect(list.find(t=>t.id===targetId).webSocketDebuggerUrl,tag);
}
async function use(next){page=next;await send('Page.bringToFront');}
// Open /play/ on the current page with a saved seat.
async function openSeat(token){
  await send('Runtime.enable');await send('Log.enable');await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:+width,height:+height,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:state.baseUrl+'/play/'});
  await until(`!!document.querySelector('.pl-connect')`,'connect screen');
  await evaluate(`localStorage.setItem('dicerealm.play.session.v1',${JSON.stringify(JSON.stringify({baseUrl:state.baseUrl,campaignId:state.campaignId,accessToken:token}))});location.reload();`);
  await sleep(500);
}
const evaluate=async expression=>(await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})).result.value;
async function until(expression,label,timeout=60000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await evaluate(expression))return;await sleep(250);}
  throw new Error('Timed out waiting for '+label+'\n'+await evaluate('document.body.innerText.slice(0,2000)'));
}
async function shot(name){
  const {data}=await send('Page.captureScreenshot',{format:'png'});
  writeFileSync(join(out,name+'.png'),Buffer.from(data,'base64'));console.log('shot',name);
}
async function click(selector){await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);}
// A real pointer press (move, press, release) at the element's centre, as a player's mouse would.
async function press(selector){
  const at=await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
  for(const type of ['mouseMoved','mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,x:at.x,y:at.y,button:'left',clickCount:1});
}
// A real drag from the element's centre by (dx,dy), in steps, as a mouse pan would.
async function drag(selector,dx,dy){
  const at=await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:at.x,y:at.y});
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:at.x,y:at.y,button:'left',clickCount:1});
  for(let i=1;i<=6;i++)await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:at.x+dx*i/6,y:at.y+dy*i/6,button:'left',buttons:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:at.x+dx,y:at.y+dy,button:'left',clickCount:1});
}
const key=k=>evaluate(`document.activeElement?.blur();document.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true}))`);
async function hover(selector){
  const at=await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:at.x,y:at.y});
}
// A card by its exact title ("学者" also appears inside "魔法初学者").
const pickCard=title=>evaluate(`[...document.querySelectorAll('.bd-card')].find(n=>n.querySelector('b').textContent===${JSON.stringify(title)}).click()`);
const settled=`!!document.querySelector('.bd-status')&&!document.querySelector('.bd-status').textContent.startsWith('正在检查')`;
// A window keeps one place and size whatever page is open in it.
const windowBox=()=>evaluate(`(()=>{const b=document.querySelector('dialog[open]').getBoundingClientRect();return [b.x,b.y,b.width,b.height].map(Math.round).join(',');})()`);
async function sameWindow(expected,page){const now=await windowBox();if(now!==expected)throw new Error('window moved or resized on '+page+': '+expected+' -> '+now);}
// The character window (C) through its tabs, one real command (unpacking a starting pack when the
// server offers it), then the journal (J).
let characterWindow='';
async function characterTour(){
  const key=k=>evaluate(`document.activeElement?.blur();document.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true}))`);
  const tab=label=>evaluate(`[...document.querySelectorAll('dialog[open] .sheet-tabs button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
  const loaded=`!!document.querySelector('dialog[open] .pco')&&!document.querySelector('dialog[open] .pco').textContent.includes('正在读取')`;
  await key('c');
  await until(`!!document.querySelector('dialog[open] .character-sheet')`,'character window');
  await sleep(600);await shot('c1-character');characterWindow=await windowBox();
  await tab('背包');await until(loaded,'inventory operations');await sleep(300);await shot('c2-inventory');await sameWindow(characterWindow,'背包');
  const unpack=`[...document.querySelectorAll('dialog[open] .pco button')].find(b=>b.textContent==='取出内容'&&!b.disabled)`;
  if(await evaluate(`!!${unpack}`)){
    await evaluate(`${unpack}.click()`);
    await until(`document.querySelector('dialog[open] .pco-status')?.textContent.includes('套装内容已放入背包')`,'unpacked');
    await until(loaded,'operations after unpack');await sleep(400);await shot('c3-unpacked');
  }
  for(const page of ['状态','能力'])await tab(page),await sleep(200),await sameWindow(characterWindow,page);
  await tab('法术');await sleep(400);await shot('c4-spells');await sameWindow(characterWindow,'法术');
  await evaluate(`document.querySelector('dialog[open]').close()`);
  await key('j');
  await until(`!!document.querySelector('dialog[open] .world-memory')`,'journal');
  await sleep(500);await shot('c5-journal');await sameWindow(characterWindow,'冒险手记');
  await evaluate(`document.querySelector('dialog[open]').close()`);
  // The rail's goal shows its objectives on hover and opens the same journal on a click.
  await hover('.pl-goal');
  await until(`!document.querySelector('.pl-hovercard').hidden&&!!document.querySelector('.pl-hovercard .pl-hc-goals li')`,'goal hover card');
  await sleep(200);await shot('c6-goal-hover');
  await press('.pl-goal');
  await until(`!!document.querySelector('dialog[open] .world-memory')`,'journal from the goal');
  await evaluate(`document.querySelector('dialog[open]').close()`);
}
// The host awards 300 experience (as the server API allows a host to), then the player previews and
// confirms level 2 on the character window's 成长 tab.
async function growthTour(){
  const host={Authorization:'Bearer '+state.hostToken,'Content-Type':'application/json'};
  const campaign=await (await fetch(state.baseUrl+'/api/v1/campaigns/'+state.campaignId,{headers:host})).json();
  const self=await evaluate(`JSON.parse(localStorage.getItem('dicerealm.play.session.v1')).accessToken`);
  const seat=await (await fetch(state.baseUrl+'/api/v1/campaigns/'+state.campaignId,{headers:{Authorization:'Bearer '+self}})).json();
  const award=await fetch(state.baseUrl+'/api/v1/campaigns/'+state.campaignId+'/characters/advancement/award',{method:'POST',headers:host,
    body:JSON.stringify({requestId:crypto.randomUUID(),expectedVersion:campaign.version,actorId:seat.party.selfActorId,kind:'experience',value:300,rationale:'网页成长验证'})});
  if(!award.ok)throw new Error('award failed: '+award.status+' '+await award.text());
  await sleep(3000);
  await evaluate(`document.activeElement?.blur();document.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}))`);
  await until(`!!document.querySelector('dialog[open] .character-sheet')`,'character window');
  await evaluate(`[...document.querySelectorAll('dialog[open] .sheet-tabs button')].find(b=>b.textContent==='成长').click()`);
  const apply=`[...document.querySelectorAll('dialog[open] .pco .btn-primary')].find(b=>b.textContent.startsWith('确认升到'))`;
  await until(`!!${apply}&&!document.querySelector('dialog[open] .pco').textContent.includes('正在预览')`,'growth preview',30000);
  await sleep(300);await shot('g1-growth');if(characterWindow)await sameWindow(characterWindow,'成长');
  if(await evaluate(`${apply}.disabled`)){console.log('growth not applicable:',await evaluate(`document.querySelector('dialog[open] .pco').innerText`));return;}
  await evaluate(`${apply}.click()`);
  await until(`document.querySelector('dialog[open] .pco-status')?.textContent.includes('已升到 2 级')`,'level 2',30000);
  await sleep(500);await shot('g2-level-2');
  await evaluate(`document.querySelector('dialog[open]').close()`);
}
// The host wounds the seat and calls a short rest, as the workbench would. The page offers the hit
// die the rest leaves; spending it goes through the usual review card.
async function restTour(){
  const host={Authorization:'Bearer '+state.hostToken,'Content-Type':'application/json'},base=state.baseUrl+'/api/v1/campaigns/'+state.campaignId;
  const self=await evaluate(`JSON.parse(localStorage.getItem('dicerealm.play.session.v1')).accessToken`);
  const seat=await (await fetch(base,{headers:{Authorization:'Bearer '+self}})).json();
  async function post(path,body){
    const campaign=await (await fetch(base,{headers:host})).json();
    const response=await fetch(base+path,{method:'POST',headers:host,body:JSON.stringify({requestId:crypto.randomUUID(),expectedVersion:campaign.version,...body})});
    if(!response.ok)throw new Error(path+' failed: '+response.status+' '+await response.text());
  }
  await post('/characters/adjust',{actorId:seat.party.selfActorId,rationale:'网页休整验证',ruleSource:'巡检',changes:[{operation:'damage',key:'',value:5}]});
  await post('/party/rest',{kind:'short'});
  const offer=`[...document.querySelectorAll('.pl-quick-act')].find(b=>b.textContent.includes('生命骰'))`,hp=`document.querySelector('.pl-member.is-me .pl-hp-n').textContent`;
  const told=text=>`[...document.querySelectorAll('.msg-result')].some(n=>n.textContent.includes(${JSON.stringify(text)}))`;
  await until(`!!${offer}&&${told('全队短休')}`,'hit die offer and the rest in the story',30000);
  const before=await evaluate(hp);
  await sleep(300);await shot('h1-rest-offer');
  await evaluate(`${offer}.click()`);
  await until(`!document.querySelector('.pl-modal').hidden&&!!document.querySelector('.pl-modal .pl-option')`,'hit die review');
  await sleep(200);await shot('h2-rest-review');
  // The hit die is the player's own roll: its card opens once, like any other.
  await click('.pl-modal .pl-option');
  await rollFromCard('h3-hit-die');
  await until(`${hp}!==${JSON.stringify(before)}&&${told('实际恢复')}`,'hit die spent and told',60000);
  await sleep(800);
  // The newest line stays in view after the row above the input goes away.
  await until(`(f=>f.scrollHeight-f.scrollTop-f.clientHeight<2)(document.querySelector('.story-feed'))`,'story at its newest line',5000);await shot('h4-rest-spent');
}
// Roll consent from the card, then close the recorded result with Space. Initiative records no
// single check, so its card simply closes.
// The card must be what the pointer reaches, not merely present under the map's own layers.
const onTop=selector=>evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),b=n.getBoundingClientRect();return n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));})()`);
async function rollFromCard(name){
  await until(`!!document.querySelector('.pl-modal:not([hidden]) .pl-roll-btn:not(:disabled)')`,'roll card '+name,90000);
  if(!await onTop('.pl-roll-btn'))throw new Error('roll card '+name+' is covered');
  await sleep(400);await shot(name);
  await click('.pl-roll-btn');
  await until(`!!document.querySelector('.pl-stamp.is-on')||document.querySelector('.pl-modal').hidden`,'result '+name);
  if(await evaluate(`!!document.querySelector('.pl-stamp.is-on')`)){
    await sleep(300);await shot(name+'-result');
    await evaluate(`document.activeElement?.blur();document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}))`);
    await until(`document.querySelector('.pl-modal').hidden`,'result closed '+name);
  }
}
// Nothing in flight: no request, no narration, and the combat bar takes input again.
const calm=`!document.querySelector('.pl-thinking:not([hidden])')&&!document.querySelector('.pl-status').textContent.startsWith('正在确认')&&!!document.querySelector('.pl-act:not([aria-disabled])')`;
const act=name=>`[...document.querySelectorAll('.pl-act')].find(n=>n.textContent.startsWith(${JSON.stringify(name)}))`;
async function combatTour(){
  await until(`document.querySelector('.pl-status').textContent.includes('写下你想做的事')&&!document.querySelector('.pl-map-img').hidden`,'ready with map',90000);
  await sleep(600);await shot('c1-explore');
  // Exploration: a rail hover card; pins (the still-hidden watchpost left out); a known place dragged
  // out of view comes back through its edge chip; a reachable place opens its travel review (Esc
  // keeps the party here); M opens and closes the big map.
  await hover('.pl-member.is-me');
  await until(`!document.querySelector('.pl-hovercard').hidden&&document.querySelector('.pl-hovercard').textContent.includes('护甲等级')`,'own hover card');
  await sleep(200);await shot('c1a-hover-card');
  await hover('.pl-feed-wrap');await until(`document.querySelector('.pl-hovercard').hidden`,'hover card gone');
  await until(`document.querySelectorAll('.pl-pin').length===3&&!document.querySelector('.pl-pin[aria-label*="旧岗哨"]')`,'three public pins');
  // The map opens 1:1 on the party's place: in a narrow window the harbour starts off the plate, in a
  // wide one it is dragged off. Either way its edge chip brings it back.
  const harbour='.pl-pin[aria-label*="雾港码头"]',chip=`[...document.querySelectorAll('.pl-edge')].find(n=>n.textContent.includes('雾港码头'))`;
  if(!await evaluate(`!!${chip}`))await drag('.pl-plate-in',-420,0);
  await until(`!!${chip}`,'edge chip for the harbour');
  await sleep(200);await shot('c1b-edge-chip');
  await evaluate(`${chip}.click()`);
  await until(`!${chip}`,'harbour back in view');
  await hover(harbour);
  await until(`!document.querySelector('.pl-pin-card').hidden&&document.querySelector('.pl-pin-card').textContent.includes('点击前往')`,'pin card');
  await sleep(200);await shot('c1c-pin-card');
  await press(harbour);
  await until(`${ready('前往雾港码头')}`,'travel review');
  await sleep(200);await shot('c1d-travel-review');
  await key('Escape');await until(`document.querySelector('.pl-modal').hidden`,'travel review closed');
  // The same places as a list behind the corner button; its 前往 opens the same review.
  await click('.pl-places-toggle');
  await until(`!document.querySelector('.pl-places').hidden&&document.querySelector('.pl-places').dataset.mode==='overlay'`,'places list over the map');
  await sleep(200);await shot('c1d2-places');
  await evaluate(`[...document.querySelectorAll('.pl-loc')].find(n=>n.textContent.includes('雾港码头')).querySelector('.pl-loc-go').click()`);
  await until(`${ready('前往雾港码头')}&&document.querySelector('.pl-places').hidden`,'travel review from the list');
  await key('Escape');await until(`document.querySelector('.pl-modal').hidden`,'travel review closed again');
  await key('m');await until(`document.querySelector('.pl-stage').classList.contains('is-map-open')&&!document.querySelector('.pl-map-close').hidden`,'big map');
  await sleep(400);await shot('c1e-big-map');
  await key('m');await until(`!document.querySelector('.pl-stage').classList.contains('is-map-open')`,'big map closed');
  await evaluate(`(()=>{const i=document.querySelector('.pl-input');i.focus();i.value='我向堤道守卫发起挑战。';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('.pl-send');
  await rollFromCard('c2-initiative');
  // The battle grid lies on the frozen map; the rail turns into the initiative list.
  await until(`!document.querySelector('.pl-combat').hidden&&!document.querySelector('.pl-grid').hidden&&!document.querySelector('.pl-map-img').hidden&&document.querySelector('.pl-rail .pl-sec').textContent==='先攻'&&document.querySelector('.pl-places-toggle').hidden`,'combat on the map',90000);
  await until(calm,'combat ready',60000);
  await sleep(600);await shot('c3-combat');
  await hover('.pl-member.is-foe');
  await until(`!document.querySelector('.pl-hovercard').hidden&&document.querySelector('.pl-hovercard').textContent.includes('敌人')`,'enemy hover card');
  await sleep(200);await shot('c3a-hover-guard');
  await hover('.pl-feed-wrap');await until(`document.querySelector('.pl-hovercard').hidden`,'enemy card gone');
  await hover('[aria-label="移动至 4,3"]');await sleep(300);await shot('c4-move-hover');
  await press('[aria-label="移动至 4,3"]');
  await until(`!!document.querySelector('[aria-label="移动至 5,3"]')`,'first step',60000);await until(calm,'after first step',60000);
  await press('[aria-label="移动至 5,3"]');
  await until(`!!${act('攻击')}&&!${act('攻击')}.hasAttribute('aria-disabled')`,'attack open',60000);await until(calm,'after second step',60000);
  await evaluate(`${act('攻击')}.click()`);
  await until(`document.querySelector('.pl-token[data-aim=open]')`,'aim');
  await sleep(300);await shot('c5-aim');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await until(`!document.querySelector('.pl-token[data-aim]')&&${act('攻击')}.getAttribute('aria-pressed')==='false'`,'aim cancelled by Esc');
  await evaluate(`${act('攻击')}.click()`);
  await press('.pl-token[data-aim=open]');
  await rollFromCard('c6-attack-roll');
  await until(calm,'after attack',60000);
  await sleep(800);await shot('c7-after-attack');
  await evaluate(`${act('结束回合')}.click()`);
  // The guard answers; round two brings Second Wind for the hurt fighter.
  await until(`!!${act('回气')}`,'round two',90000);await until(calm,'round two settled',60000);
  await sleep(800);await shot('c8-round-two');
  await evaluate(`${act('回气')}.click()`);
  await until(`!!document.querySelector('.pl-modal:not([hidden]) .pl-option')`,'review card');
  await sleep(300);await shot('c9-review');
  await click('.pl-modal .pl-option');
  await rollFromCard('c10-second-wind-roll');
  await until(calm,'after second wind',60000);
  await sleep(800);await shot('c11-after-second-wind');
}
// A choice on the open card by the start of its title.
const choice=text=>`[...document.querySelectorAll('.pl-modal:not([hidden]) .pl-option')].find(n=>n.querySelector('b').textContent.startsWith(${JSON.stringify(text)}))`;
const ready=text=>`!!${choice(text)}&&!${choice(text)}.hasAttribute('aria-disabled')`;
async function wizardTour(){
  await until(`document.querySelector('.pl-status').textContent.includes('写下你想做的事')&&!document.querySelector('.pl-map-img').hidden`,'ready with map',90000);
  await evaluate(`(()=>{const i=document.querySelector('.pl-input');i.focus();i.value='我向堤道守卫发起挑战。';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('.pl-send');
  await rollFromCard('w1-initiative');
  await until(`!document.querySelector('.pl-combat').hidden&&!document.querySelector('.pl-map-img').hidden`,'combat on the map',90000);
  await until(calm,'combat ready',60000);
  await evaluate(`${act('施法')}.click()`);
  await until(ready('魔法飞弹'),'cast review');
  await sleep(300);await shot('w2-cast-review');
  await evaluate(`${choice('魔法飞弹')}.click()`);
  // The allocation card opens by itself and stays open through each edit until the cast.
  await until(`${ready('魔法飞弹 / 分配一枚至 堤道守卫')}&&document.querySelector('.pl-modal .pl-card-why').textContent.includes('分配')`,'allocation card',60000);
  await sleep(300);await shot('w3-allocate');
  await evaluate(`${choice('魔法飞弹 / 分配一枚至 堤道守卫')}.click()`);
  await until(ready('魔法飞弹 / 剩余全部 2枚至 堤道守卫'),'one missile allocated',60000);
  // The other two on the map: the card steps aside, each click places one, and the card comes back
  // with the cast once none are left.
  await evaluate(`${choice('在地图上点选目标')}.click()`);
  const mapHint=`document.querySelector('.pl-map-hint')`,guard='.pl-token[data-team=enemy]';
  await until(`document.querySelector('.pl-modal').hidden&&!${mapHint}.hidden&&${mapHint}.textContent.includes('已分配1/3')&&document.querySelector('${guard}').dataset.aim==='open'`,'missile targeting');
  await sleep(300);await shot('w3b-allocate-on-map');
  await press(guard);
  await until(`${mapHint}.textContent.includes('已分配2/3')&&document.querySelector('${guard}').getAttribute('aria-disabled')!=='true'`,'second missile',60000);
  await press(guard);
  await until(ready('魔法飞弹 / 确认已分配飞弹'),'all missiles allocated',60000);
  await sleep(300);await shot('w4-allocated');
  await evaluate(`${choice('魔法飞弹 / 确认已分配飞弹')}.click()`);
  await rollFromCard('w5-cast-consent');
  await until(calm,'after missiles',60000);
  await sleep(800);await shot('w6-after-missiles');
  // The guard closes in and hits; the Shield card opens by itself in the guard's turn.
  await evaluate(`${act('结束回合')}.click()`);
  await until(ready('放弃护盾术反应'),'shield card',90000);
  await sleep(300);await shot('w7-shield');
  await evaluate(`${choice('放弃护盾术反应')}.click()`);
  // Down at 0 HP: each own turn opens the death save consent by itself. Cancelling it keeps the death
  // wait without popping the card up again; the bar's button asks the server for the roll anew.
  await until(`!!document.querySelector('.pl-modal:not([hidden]) .pl-roll-btn:not(:disabled)')`,'death save card',90000);
  await evaluate(`[...document.querySelectorAll('.pl-modal .pl-card-link')].find(n=>n.textContent==='放弃这次投掷').click()`);
  await until(`document.querySelector('.pl-modal').hidden&&document.querySelector('.pl-notice-label').textContent==='需要你回应'&&!!${act('死亡豁免')}&&!${act('死亡豁免')}.hasAttribute('aria-disabled')`,'death wait kept',60000);
  await sleep(3000);
  if(!await evaluate(`document.querySelector('.pl-modal').hidden`))throw new Error('The cancelled death save popped up again.');
  await shot('w8-cancelled');
  await evaluate(`${act('死亡豁免')}.click()`);
  await rollFromCard('w8-death-save');
  await until(`document.querySelector('.pl-rail').textContent.includes('死亡豁免 成功1')`,'first save recorded',90000);
  await sleep(800);await shot('w9-after-save');
  await rollFromCard('w10-second-save');
  await until(`document.querySelector('.pl-member.is-me .pl-hp-n')?.textContent.startsWith('1/')&&!document.querySelector('.pl-thinking:not([hidden])')`,'back at 1 HP',90000);
  await sleep(800);await shot('w11-natural-20');
}
const esc=()=>evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
const focused=`document.querySelector('.pl-rail').textContent.includes('专注 · 剑刃防护')`;
async function casterTour(){
  await until(`document.querySelector('.pl-status').textContent.includes('写下你想做的事')&&!document.querySelector('.pl-map-img').hidden`,'ready with map',90000);
  await evaluate(`(()=>{const i=document.querySelector('.pl-input');i.focus();i.value='我向堤道守卫发起挑战。';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('.pl-send');
  await rollFromCard('k1-initiative');
  await until(`!document.querySelector('.pl-combat').hidden&&!document.querySelector('.pl-map-img').hidden`,'combat on the map',90000);
  await until(calm,'combat ready',60000);
  // Acid Splash's many centres are one entry; Blade Ward starts the concentration.
  await evaluate(`${act('施法')}.click()`);
  await until(`${ready('剑刃防护')}&&${choice('酸液飞溅（法师）')}?.textContent.includes('在地图上选择中心')`,'cast review');
  await sleep(300);await shot('k2-cast-review');
  await evaluate(`${choice('剑刃防护')}.click()`);
  await rollFromCard('k3-blade-ward-consent');
  await until(`${focused}&&${calm}`,'concentrating',90000);
  await sleep(800);await shot('k3-concentrating');
  // The guard hits: Shield is passed, then the concentration save comes to her by itself and holds.
  await evaluate(`${act('结束回合')}.click()`);
  await until(ready('放弃护盾术反应'),'shield card',90000);
  await evaluate(`${choice('放弃护盾术反应')}.click()`);
  // The card that answered Shield follows the battle into the concentration save, retitled.
  await until(`${ready('维持专注')}&&document.querySelector('.pl-modal .pl-card-title').textContent==='专注豁免'`,'concentration card',90000);
  await sleep(300);await shot('k4-concentration');
  await evaluate(`${choice('维持专注')}.click()`);
  await rollFromCard('k5-concentration-roll');
  await until(`${calm}&&!!${act('施法')}&&!${act('施法')}.hasAttribute('aria-disabled')&&document.querySelector('.pl-modal').hidden`,'round two',90000);
  if(!await evaluate(focused))throw new Error('Blade Ward should survive the passed save.');
  await sleep(800);await shot('k6-round-two');
  // Acid Splash on the map: hovering a centre shows its reach; Esc gives the centres up.
  const pickSplash=async()=>{
    await evaluate(`${act('施法')}.click()`);await until(ready('酸液飞溅（法师）'),'cast review again');
    await evaluate(`${choice('酸液飞溅（法师）')}.click()`);
    await until(`!!document.querySelector('.pl-cell.is-center')&&!document.querySelector('.pl-map-hint').hidden&&document.querySelector('.pl-modal').hidden`,'centres');
  };
  await pickSplash();
  const guardOnly='.pl-cell.is-center:not([aria-disabled])[title="波及：堤道守卫"]',both='.pl-cell.is-center:not([aria-disabled])[title*="Arden（你）"][title*="堤道守卫"]';
  await hover(guardOnly);
  await until(`!document.querySelector('.pl-area').hidden&&document.querySelectorAll('.pl-token[data-hit]').length===1`,'reach of a centre');
  await sleep(300);await shot('k7-centre-hover');
  await esc();
  await until(`!document.querySelector('.pl-cell.is-center')&&document.querySelector('.pl-map-hint').hidden&&document.querySelector('.pl-area').hidden`,'centres given up');
  // The centre that also catches Arden: the card discloses it before anything is spent.
  await pickSplash();
  await hover(both);
  await until(`document.querySelectorAll('.pl-token[data-hit]').length===2`,'reach over both');
  await sleep(300);await shot('k8-friendly-fire');
  await press(both);
  await until(`${ready('酸液飞溅')}&&document.querySelector('.pl-modal').textContent.includes('Arden（同伴）')`,'centre card');
  await sleep(300);await shot('k9-centre-review');
  await evaluate(`${choice('酸液飞溅')}.click()`);
  await rollFromCard('k10-splash-consent');
  // Her own DEX save, then the concentration save its damage forces, before the guard's save.
  await until(`${ready('区域效果 / 本人豁免')}&&document.querySelector('.pl-modal .pl-card-why').textContent.startsWith('酸液飞溅影响此角色；等待本人确认DC12 敏捷豁免')`,'area save card',90000);
  await sleep(300);await shot('k10-area-save-card');
  await evaluate(`${choice('区域效果 / 本人豁免')}.click()`);
  await rollFromCard('k11-area-roll');
  await until(ready('维持专注'),'second concentration card',90000);
  await evaluate(`${choice('维持专注')}.click()`);
  await rollFromCard('k12-concentration-fails');
  await until(`!document.querySelector('.pl-rail').textContent.includes('专注 · ')&&${calm}&&document.querySelector('.pl-modal').hidden`,'concentration ended',90000);
  await sleep(800);await shot('k13-after-area');
}
const challenge=async()=>{
  await evaluate(`(()=>{const i=document.querySelector('.pl-input');i.focus();i.value='我向堤道守卫发起挑战。';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('.pl-send');
};
async function partyTour(){
  const host=page,guest=await newPage('guest');
  await use(guest);await openSeat(state.guestToken);
  await until(`!!document.querySelector('.pl-stage')&&!document.querySelector('.pl-map-img').hidden`,'guest seat ready',90000);
  await use(host);
  await until(`document.querySelector('.pl-status').textContent.includes('写下你想做的事')&&!document.querySelector('.pl-map-img').hidden`,'host ready with map',90000);
  await challenge();
  // Each seat consents to its own initiative; the fight starts once both have.
  await rollFromCard('p1-host-initiative');
  await until(`document.querySelector('.pl-notice').textContent.includes('你已确认')&&document.querySelector('.pl-modal').hidden`,'host waits for the party');
  await sleep(300);await shot('p1b-host-waits-for-party');
  await use(guest);
  await rollFromCard('p2-guest-initiative');
  await until(`!document.querySelector('.pl-grid').hidden&&document.querySelector('.pl-rail .pl-sec').textContent==='先攻'`,'guest sees the fight',90000);
  await use(host);
  await until(calm,'host turn',90000);
  await sleep(600);await shot('p3-host-turn');
  await use(guest);await sleep(300);await shot('p4-guest-waits');
  // The host's Acid Splash on the centre that catches Bram and the guard, not Arden.
  await use(host);
  await evaluate(`${act('施法')}.click()`);await until(ready('酸液飞溅（法师）'),'cast review');
  await evaluate(`${choice('酸液飞溅（法师）')}.click()`);
  await until(`!!document.querySelector('.pl-cell.is-center')&&document.querySelector('.pl-modal').hidden`,'centres');
  const both='.pl-cell.is-center:not([aria-disabled])[title*="Bram（同伴）"][title*="堤道守卫"]:not([title*="（你）"])';
  await hover(both);await until(`document.querySelectorAll('.pl-token[data-hit]').length===2`,'reach over Bram and the guard');
  await sleep(300);await shot('p5-host-centre');
  await press(both);
  await until(`${ready('酸液飞溅')}&&document.querySelector('.pl-modal').textContent.includes('Bram（同伴）')`,'centre card');
  await sleep(300);await shot('p6-host-centre-card');
  await evaluate(`${choice('酸液飞溅')}.click()`);
  await rollFromCard('p7-host-splash-consent');
  // Bram's save belongs to Bram's seat: it opens on the guest's page.
  await use(guest);
  await until(ready('区域效果 / 本人豁免'),'guest area save card',90000);
  await sleep(300);await shot('p8-guest-area-save');
  await evaluate(`${choice('区域效果 / 本人豁免')}.click()`);
  await rollFromCard('p9-guest-area-roll');
  await use(host);
  await until(`${calm}&&!!${act('结束回合')}&&document.querySelector('.pl-modal').hidden`,'host turn after the splash',90000);
  await sleep(800);await shot('p10-host-after-splash');
  await evaluate(`${act('结束回合')}.click()`);
  // Bram's turn on the guest's page: attack the guard from the map.
  await use(guest);
  await until(`${calm}&&!!${act('攻击')}&&!${act('攻击')}.hasAttribute('aria-disabled')&&document.querySelector('.pl-modal').hidden`,'guest turn',90000);
  await sleep(600);await shot('p11-guest-turn');
  await evaluate(`${act('攻击')}.click()`);
  await until(`document.querySelector('.pl-token[data-aim=open]')`,'guest aim');
  await press('.pl-token[data-aim=open]');
  await rollFromCard('p12-guest-attack');
  await until(`${calm}&&document.querySelector('.pl-modal').hidden`,'guest after attack',90000);
  await evaluate(`${act('结束回合')}.click()`);
  // The guard acts; round two comes back to the host.
  await use(host);
  await until(`${calm}&&document.querySelector('.pl-notice').textContent.includes('第 2 轮')`,'round two',120000);
  await sleep(800);await shot('p13-host-round-two');
  await use(guest);await sleep(300);await shot('p14-guest-round-two');
  await use(host);
}
async function joinAsNewPlayer(){
  await evaluate(`(()=>{const [room,pw]=document.querySelectorAll('.pl-join input');room.value=${JSON.stringify(state.roomNumber)};pw.value=${JSON.stringify(state.password)};})()`);
  await click('.pl-join .btn-primary');
  await until(`!!document.querySelector('.qb')`,'quick creation');await sleep(300);await shot('q1-start');
  // A name first; then every class must come out as a character the server accepts, ready to join.
  await evaluate(`(()=>{const i=document.querySelector('.qb-name input');i.value='阿岚';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const joinable=name=>`!document.querySelector('.qb .btn-primary').disabled&&document.querySelector('.qb-classes .is-on b')?.textContent===${JSON.stringify(name)}`;
  for(const name of await evaluate(`[...document.querySelectorAll('.qb-classes .bd-card b')].map(b=>b.textContent)`)){
    await pickCard(name);await until(joinable(name),'joinable '+name,20000);
  }
  await pickCard('法师');await until(joinable('法师'),'wizard');
  await evaluate(`[...document.querySelectorAll('.qb-chip')].find(b=>b.textContent==='精灵').click()`);
  await until(`${joinable('法师')}&&document.querySelector('.qb-line').textContent.startsWith('精灵')`,'elf wizard');
  await sleep(300);await shot('q2-elf-wizard');
  // 「详细调整」 opens the full builder on the same character with every step filled; closing comes back.
  await click('.qb .bd-foot .btn:not(.btn-primary)');
  await until(`!!document.querySelector('.bd')&&${settled}`,'detailed builder');
  const open=await evaluate(`[...document.querySelectorAll('.bd-steps small')].filter(s=>s.textContent.startsWith('待完成')).length`);
  if(open)throw new Error('the quick character left '+open+' builder steps open');
  await sleep(300);await shot('q3-detailed');
  await click('.bd-close');
  await until(`!!document.querySelector('.qb')&&${joinable('法师')}`,'back to quick creation');
  await click('.qb .bd-foot .btn-primary');
  await until(`!!document.querySelector('.pl-stage')`,'joined seat');
  await sleep(1200);await shot('b9-joined-waiting');
  // The host returns the character, as the workbench would; the page sees it on its next read.
  const host={Authorization:'Bearer '+state.hostToken,'Content-Type':'application/json'};
  async function decide(decision,reason){
    const campaign=await (await fetch(state.baseUrl+'/api/v1/campaigns/'+state.campaignId,{headers:host})).json();
    const member=campaign.party.members.find(m=>m.id!==campaign.party.selfActorId&&m.review?.status==='pending');
    const review=await fetch(state.baseUrl+'/api/v1/campaigns/'+state.campaignId+'/characters/review',{method:'POST',headers:host,
      body:JSON.stringify({requestId:crypto.randomUUID(),expectedVersion:campaign.version,actorId:member.id,revision:member.review.revision,decision,reason})});
    if(!review.ok)throw new Error(decision+' failed: '+review.status+' '+await review.text());
  }
  await decide('return','名字和背景对不上，换一个更像学者的名字。');
  await until(`!document.querySelector('.pl-lifecycle-act').hidden`,'returned notice',30000);
  await sleep(300);await shot('r1-returned');
  // The player rebuilds from the current card (a new name only) and sends it back with a note.
  await click('.pl-lifecycle-act');
  await until(`!!document.querySelector('dialog[open] .pl-resubmit-note')`,'resubmit window');await shot('r2-resubmit');
  await evaluate(`[...document.querySelectorAll('dialog[open] .btn')].find(b=>b.textContent.startsWith('修改角色')).click()`);
  await until(`!!document.querySelector('.pl-rebuild .bd')&&${settled}`,'rebuild');
  await evaluate(`[...document.querySelectorAll('.bd-steps button')][6].click()`);
  await evaluate(`(()=>{const i=document.querySelector('.bd-field input');i.value='岚书';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(settled,'new name');
  await evaluate(`[...document.querySelectorAll('.bd-steps button')][7].click()`);
  await until(`!document.querySelector('.bd-foot .btn-primary').disabled`,'rebuild complete',15000);
  await click('.bd-foot .btn-primary');
  await until(`(document.querySelector('dialog[open] .pl-resubmit-new')?.textContent||'').includes('岚书')`,'rebuilt card in the window');
  await evaluate(`(()=>{const t=document.querySelector('dialog[open] .pl-resubmit-note');t.value='改名为岚书，更贴合学者背景。';t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(200);await shot('r3-rebuilt');
  await evaluate(`[...document.querySelectorAll('dialog[open] .btn-primary')].find(b=>b.textContent==='提交审核').click()`);
  await until(`document.querySelector('.pl-lifecycle').textContent.includes('第 2 次')`,'resubmitted',30000);
  await sleep(300);await shot('r4-resubmitted');
  await decide('approve','网页加入验证');
}

try{
  await send('Runtime.enable');await send('Log.enable');await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:+width,height:+height,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:state.baseUrl+'/play/'});
  await until(`!!document.querySelector('.pl-connect')`,'connect screen');
  await shot('0-connect');
  if(mode==='--join')await joinAsNewPlayer();
  else{
    await evaluate(`localStorage.setItem('dicerealm.play.session.v1',${JSON.stringify(JSON.stringify({baseUrl:state.baseUrl,campaignId:state.campaignId,accessToken:state.accessToken}))});location.reload();`);
    await sleep(500);
  }
  if(mode==='--combat')await combatTour();
  else if(mode==='--wizard')await wizardTour();
  else if(mode==='--caster')await casterTour();
  else if(mode==='--party')await partyTour();
  else{
  // The opening is sent once by itself; its prose lands in the story.
  // A new room sends its opening by itself; a campaign without one is ready for the first action.
  await until(`[...document.querySelectorAll('.msg-dm')].some(n=>n.textContent.includes('门旁'))||document.querySelector('.pl-status').textContent.includes('写下你想做的事')`,'opening or first action',90000);
  // A seat's own opening (private only when another seat already wrote the public one) must finish:
  // until then the input stays disabled.
  await until(`!document.querySelector('.pl-thinking:not([hidden])')&&!document.querySelector('.pl-input').disabled`,'opening settled',30000);
  await sleep(800);await shot('1-ready');
  // No published map here: the pane lists the known places instead.
  await until(`!document.querySelector('.pl-places').hidden&&document.querySelector('.pl-places').dataset.mode==='full'&&document.querySelector('.pl-map-empty').hidden`,'places list as the map pane');
  await evaluate(`(()=>{const i=document.querySelector('.pl-input');i.focus();i.value='我四处看看，留意屋里的动静，再想想该走哪条路';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await shot('2-typed');
  await click('.pl-send');
  // The host asks first: the question stands whole under the story, the bar points to the input,
  // and giving up is a quiet link; the answer goes back through the same input.
  await until(`!document.querySelector('.pl-ask').hidden&&document.querySelector('.pl-ask').textContent.includes('鱼市后的窄巷')`,'host question',90000);
  const asked=await evaluate(`({notice:document.querySelector('.pl-notice').innerText,quiet:document.querySelector('.pl-notice-btn').classList.contains('is-quiet'),send:document.querySelector('.pl-send').innerText})`);
  if(!asked.notice.includes('在输入框写下你的回答')||!asked.quiet||!asked.send.includes('回答'))throw new Error('question bar: '+JSON.stringify(asked));
  // No record exists yet, but the seat's own words already stand in the story.
  const ownLine=`[...document.querySelectorAll('.story-feed .msg-player')].filter(n=>n.textContent.includes('再想想该走哪条路')).length`;
  if(await evaluate(ownLine)!==1)throw new Error('own action missing while the host asks');
  await sleep(400);await shot('2b-question');
  await evaluate(`(()=>{const i=document.querySelector('.pl-input');i.focus();i.value='走码头的石阶';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('.pl-send');
  await until(`document.querySelector('.pl-ask').hidden`,'question answered',30000);
  await until(`!!document.querySelector('.pl-modal:not([hidden]) .pl-roll-btn')`,'roll card',90000);
  await sleep(400);await shot('3-roll-card');
  if(!await onTop('.pl-roll-btn'))throw new Error('roll card is covered by the map pane');
  // Watch for the narration that follows being revealed character by character (visual-v3 §5).
  await evaluate(`window.__revealed=false;new MutationObserver(()=>{if(document.querySelector('.story-feed .reveal-rest'))window.__revealed=true;}).observe(document.querySelector('.story-feed'),{subtree:true,childList:true})`);
  await click('.pl-roll-btn');
  await until(`!!document.querySelector('.pl-stamp')`,'roll result');
  await sleep(350);await shot('4-rolling');
  await until(`!!document.querySelector('.pl-stamp.is-on')`,'stamp');
  await sleep(300);await shot('5-roll-result');
  await evaluate(`document.activeElement?.blur();document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}))`);
  await until(`document.querySelector('.pl-modal').hidden`,'card closed by Space');
  // The page continues by itself after the recorded roll; the DM's prose follows.
  await until(`[...document.querySelectorAll('.msg-dm')].some(n=>n.textContent.includes('擦着肩头'))`,'narration after roll',90000);
  // New narration is laid out whole and revealed; Space shows the rest at once.
  if(await evaluate(`!!document.querySelector('.story-feed .reveal-rest')`)){
    await shot('6a-revealing');
    await evaluate(`document.activeElement?.blur();document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}))`);
    await until(`!document.querySelector('.story-feed .reveal-rest')`,'Space shows the narration whole',1000);
  }
  if(!await evaluate('window.__revealed'))throw new Error('new narration was not revealed');
  await until(`!document.querySelector('.pl-thinking:not([hidden])')`,'settled',30000);
  await sleep(800);await shot('6-after-roll');
  if(await evaluate(ownLine)!==1)throw new Error('own action shown twice or lost after its record');
  await characterTour();
  if(mode!=='--join'){await growthTour();await restTour();}
  }
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await sleep(600);await shot('7-1440');
  if(mode==='--join'){
    // Leaving the seat keeps it on this browser's list.
    await evaluate(`[...document.querySelectorAll('.pl-entry')].find(n=>n.textContent.includes('返回入口')).click()`);
    await until(`!!document.querySelector('.pl-seats li')`,'saved seats');
    await shot('8-entrance-seats');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate(`[...document.querySelectorAll('.pl-seats .btn-primary')][0].click()`);
    await until(`!!document.querySelector('.pl-stage')`,'seat reopened');
  }
  const summary=await evaluate(`({status:document.querySelector('.pl-status').textContent,notice:document.querySelector('.pl-notice').hidden?'':document.querySelector('.pl-notice').innerText,
    input:document.querySelector('.pl-input').value,messages:[...document.querySelectorAll('.story-feed .msg')].map(n=>n.className+' | '+n.innerText.replace(/\\s+/g,' ').slice(0,120))})`);
  console.log(JSON.stringify(summary,null,1));
}catch(error){console.error(error.message);await shot('error').catch(()=>{});process.exitCode=1;}
finally{console.log('problems:',JSON.stringify(problems,null,1));sockets.forEach(ws=>ws.close());proc.kill();}
