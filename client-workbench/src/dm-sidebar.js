import {h,initial} from './dom.js';
import {ruleName,buildName} from './rule-labels.js';
import {resourceName as resourceLabel} from './character-sheet.js';
import {createPresentationMotion} from './presentation-motion.js';

const preference='dicerealm.workbench.dm-sidebar.collapsed.v1';
const scope=s=>JSON.stringify([s.id,s.timelineId||'',s.party?.selfActorId,s.party?.isHost]);
const stamp=s=>scope(s)+':'+s.version;
const svg=(tag,attrs={},text='')=>{
  const node=document.createElementNS('http://www.w3.org/2000/svg',tag);
  for(const [key,value] of Object.entries(attrs))node.setAttribute(key,String(value));
  if(text)node.textContent=text;return node;
};

// One reader driven by the story's existing dashboard updates, with no timer. It is the
// right-hand pane of the story page: party, the current scene's private notes and a read-only
// DM map. A task pane takes its place while open (`setBlocked`); collapse is remembered locally.
export function createDmSidebar(owner,ctx,{dialogs,openCharacter,storage=globalThis.localStorage,onVisibility=()=>{},onExpand=()=>{}}={}){
  let disposed=false,blocked=false,collapsed=false,generation=0,pendingKey='',failedKey='',data=null,error='',signature='',windowState=null;
  let context=scope(ctx.snapshot);
  const media=new Map();
  const motion=createPresentationMotion(owner),values=new Map();let animateValues=false;
  try{collapsed=storage?.getItem(preference)==='true';}catch{/* Browser storage may be disabled; keep the in-memory preference. */}
  const host=()=>!disposed&&ctx.snapshot.party?.isHost===true;
  const body=h('div.pane-body.ov-body'),status=h('p.small.muted.ov-status',{role:'status'});
  const retry=h('button.btn.btn-sm.ov-retry',{type:'button',hidden:true,onclick:()=>load(true)},'重试读取主持概览');
  const collapse=h('button.linkish',{type:'button','aria-controls':'dm-sidebar',onclick:()=>setCollapsed(true)},'收起');
  const toggle=h('button.linkish',{type:'button','aria-controls':'dm-sidebar',onclick:()=>{setCollapsed(false);onExpand();}},'主持概览');
  const element=h('section.pane.pane-overview',{id:'dm-sidebar','aria-label':'主持概览'},
    h('header.pane-head',{},h('div.side-h',{},h('h2.side-title',{},'主持概览'),collapse)),status,retry,body);
  const mapButton=h('button.linkish',{type:'button','data-dm-map':'true','aria-label':'打开完整 DM 地图',onclick:openMap},'打开完整地图');
  function visibility(){
    element.hidden=!host()||collapsed||blocked;
    toggle.hidden=!host()||!collapsed;
    collapse.setAttribute('aria-expanded',String(!collapsed));toggle.setAttribute('aria-expanded',String(!collapsed));
    onVisibility(host()&&!collapsed);
  }
  function setCollapsed(value){
    collapsed=value;try{storage?.setItem(preference,String(value));}catch{/* In-memory behavior remains available. */}
    visibility();if(collapsed)toggle.focus({preventScroll:true});else {motion(element,'slide');void load();}
  }
  function releaseMedia(){for(const item of media.values())if(item.url)URL.revokeObjectURL(item.url);media.clear();}
  function clear(){data=null;signature='';values.clear();body.replaceChildren();releaseMedia();windowState?.close();windowState=null;}
  owner.addEventListener('dispose',()=>{disposed=true;generation++;clear();},{once:true});
  function image(endpoint,payload,key,alt){
    let item=media.get(key);
    if(!item){
      item={url:'',error:false};media.set(key,item);const ownContext=context;
      Promise.resolve(ctx.read(endpoint,payload)).then(blob=>{
        if(!host()||context!==ownContext||media.get(key)!==item)return;
        item.url=URL.createObjectURL(blob);signature='';draw();drawMapWindow();
      }).catch(()=>{if(host()&&context===ownContext&&media.get(key)===item){item.error=true;signature='';draw();drawMapWindow();}});
    }
    return item.url?h('img',{src:item.url,alt,draggable:false}):h('span.dm-image-fallback',{},item.error?'图片暂不可用':alt);
  }
  function portrait(member){
    const p=member.character.portrait;
    return p?.status==='ready'?image('portrait-image',{actorId:member.id,portraitId:p.id,contentHash:p.contentHash},
      'portrait:'+member.id+':'+p.id+':'+p.contentHash,member.character.name):h('span',{},initial(member.character.name));
  }
  function memberCard(member){
    const c=member.character,review=member.review?.status&&member.review.status!=='approved'?member.review.status:'';
    const ratio=Math.max(0,Math.min(1,c.hitPoints/Math.max(1,c.maxHitPoints)));
    const bar=svg('svg',{viewBox:'0 0 100 6',preserveAspectRatio:'none','aria-hidden':'true',class:'pc-bar'+(ratio<=.25?' is-low':ratio<=.5?' is-hurt':'')});
    bar.append(svg('rect',{x:0,y:0,width:100,height:6,class:'pc-bar-track'}),svg('rect',{x:0,y:0,width:ratio*100,height:6,class:'pc-bar-fill'}));
    const button=h('button.pc-seal',{type:'button','data-dm-member':member.id,'aria-label':'查看 '+c.name+' 的角色资料',title:'查看角色资料',class:review?'is-wait':null},portrait(member));
    button.onclick=()=>openCharacter?.(member.id,button);
    const resources=(c.resources||[]).filter(r=>r.maximum>0);
    return h('article.pc',{'data-member':member.id},button,
      h('div.pc-main',{},
        h('div.pc-name',{},h('span',{},c.name),h('small',{},ruleName(c.className)+' '+c.level)),
        review==='pending'?h('p.pc-hp.none',{},'待审核，尚未加入队伍'):
          h('div.pc-hp',{},bar,h('span.dm-vitals',{},h('span.sr-only',{},'生命 '+c.hitPoints+' / '+c.maxHitPoints),
            h('b',{'aria-hidden':'true'},c.hitPoints),h('small',{'aria-hidden':'true'},' / '+c.maxHitPoints)),
            c.temporaryHitPoints>0?h('span.dm-temp',{},'临时生命 +'+c.temporaryHitPoints):null),
        resources.length&&review!=='pending'?h('p.dm-resources',{},...resources.map(r=>h('span',{title:r.description||''},resourceLabel(r.name)+' '+r.current+'/'+r.maximum))):null),
      h('div.pc-tags',{},h('span.tag',{},'AC '+c.armorClass),
        ...(c.conditions||[]).map(value=>h('span.tag.is-warn',{},ruleName(value))),
        c.concentration?h('span.tag.is-warn',{},'专注 · '+buildName('spell',c.concentration.spellId)):null,
        review?h('span.tag.is-warn',{},review==='pending'?'待审核':'已退回'):null));
  }
  function encounterDetails(){
    const read=data.encounter,setup=read.encounter,authored=data.scene.authoredEncounter;
    if(!setup&&!authored)return [h('p.small.muted',{},'本场景尚无遭遇准备。')];
    const concealment=setup?.concealment||[];
    const rows=(read.roster||[]).map(unit=>{
      const hidden=concealment.find(e=>e.entityId===unit.id),known=(hidden?.knownActors||[]).map(id=>data.party.find(p=>p.id===id)?.character.name||id);
      const stats=unit.statistics,facts=[Number.isFinite(stats?.armorClass)?'AC '+stats.armorClass:'',
        Number.isFinite(stats?.hitPoints)?'生命 '+stats.hitPoints+(Number.isFinite(stats?.maxHitPoints)?' / '+stats.maxHitPoints:''):''].filter(Boolean);
      return h('li.dm-foe',{},h('strong',{},unit.name),h('span.tag',{class:hidden?.hidden||unit.visibility==='gm'?'is-warn':null},hidden?.hidden?'躲藏中':unit.visibility==='gm'?'未公开':'已公开'),
        facts.length?h('span.dm-foe-stats',{},facts.join(' · ')):null,
        hidden?h('details.dm-foe-details',{},h('summary',{},'隐匿详情'),
          h('p.small',{},'已发现：'+(known.join('、')||'无人')+'；隐匿 '+hidden.stealth.total),
          hidden.reason?h('p.small.muted',{},hidden.reason):null):null);
    });
    return [h('p.dm-encounter-title',{},setup?.definition?.title||authored?.title||'当前遭遇',
        setup?h('span.small.muted',{},setup.layout?' · 战术布局已绑定':' · 尚未绑定战术布局'):null),
      setup?.layoutReason?h('p.small.muted',{},setup.layoutReason):null,
      rows.length?h('ul.dm-encounter',{},...rows):h('p.small.muted',{},'尚无运行时单位。'),
      authored?h('details',{},h('summary',{},'剧本遭遇设定'),...(authored.enemies||[]).map(e=>h('p.small',{},e.name+' · HP '+e.hitPoints+' · AC '+e.armorClass))):null].filter(Boolean);
  }
  function sceneBlock(){
    const scene=data.scene,records=scene.records||[];
    const notes=records.filter(e=>e.kind==='npc'||e.visibility==='host'||e.hidden);
    const record=e=>h('div.dm-note',{'data-private':e.hidden||e.visibility==='host'?'true':'false'},
      h('strong',{},e.name),h('span.dm-private-tag',{},e.hidden?'已隐藏':e.visibility==='host'?'仅主持':'公开记录'),h('p',{},e.summary));
    const npcs=scene.npcs||[];
    return h('section.ov-sec',{},h('div.sec-h',{},h('span',{},'当前场景'),h('span.ver',{},'仅主持')),
      h('div.secret',{},
        h('div.secret-place',{},h('span',{},scene.title),h('small',{},'私密资料')),
        scene.summary?h('p.secret-summary',{},scene.summary):null,
        npcs.length?h('dl.secret-facts',{},h('dt',{},'相关人物'),h('dd',{},npcs.map(n=>n.name+(n.met?'':'（未会面）')).join(' · '))):null,
        ...npcs.filter(n=>n.summary).map(n=>h('div.dm-note',{},h('strong',{},n.name),h('span.dm-private-tag',{},n.met?'已会面':'尚未会面'),h('p',{},n.summary))),
        ...notes.map(record),
        !npcs.length&&!notes.length?h('p.small.muted',{},'暂无人物或秘密记录。'):null),
      h('div.dm-private',{},h('h3.sec-h',{},h('span',{},'遭遇准备')),...encounterDetails()));
  }
  function mapPicture(){
    const map=data.board.map,key='map:'+map.id+':'+map.version+':'+map.contentHash;
    return h('div.dm-map-image',{},image('map-image',{mapId:map.id},key,map.title));
  }
  function mapDrawing(){
    const board=data?.board;if(!board)return h('p.small.muted',{},'当前场景没有可用地图。');
    const map=board.map,picture=mapPicture();
    const drawing=svg('svg',{viewBox:'0 0 '+map.width+' '+map.height,role:'img','aria-label':map.title+' · DM视角，含隐藏单位'});
    drawing.classList.add('dm-map-overlay');
    for(const [index,t] of board.tokens.filter(t=>t.onMap).entries()){
      const group=svg('g',{'class':t.visibility==='gm'?'dm-token dm-token-hidden':'dm-token'});
      group.append(svg('title',{},t.name+(t.visibility==='gm'?' · 未公开':'')),svg('circle',{cx:t.x*map.width,cy:t.y*map.height,r:map.width*.018}),
        svg('text',{x:t.x*map.width,y:t.y*map.height,'font-size':map.width*.02,'text-anchor':'middle','dominant-baseline':'central'},String(index+1)));
      drawing.append(group);
    }
    picture.append(drawing);return picture;
  }
  function mapLegend(){return h('ul.dm-map-legend',{},...(data?.board?.tokens||[]).map(t=>h('li',{},
    h('span',{},t.onMap?String(data.board.tokens.filter(x=>x.onMap).findIndex(x=>x.id===t.id)+1):'—'),
    h('span',{},t.name),h('span.small.muted',{},!t.onMap?'图外':t.visibility==='gm'?'未公开':'公开'))));}
  function mapBlock(){
    return h('section.ov-sec',{},h('div.sec-h',{},h('span',{},'DM 地图'),h('span',{},'只读')),
      data.board?h('div.mini',{},mapDrawing()):h('p.small.muted',{},'当前场景没有可用地图。'),
      data.board?h('div.mini-foot',{},h('span',{},'空心标记为玩家尚未得知'),mapButton):null);
  }
  function drawMapWindow(){if(!windowState||windowState.isDisposed())return;windowState.body.replaceChildren(mapDrawing(),mapLegend());}
  function openMap(){
    if(!data?.board||!host())return;
    dialogs.open({title:data.board.map.title+' · DM地图',wide:true,returnFocus:()=>mapButton,render:state=>{
      windowState=state;state.body.classList.add('dm-map-reader');state.body.addEventListener('dispose',()=>{if(windowState===state)windowState=null;},{once:true});drawMapWindow();
    }});
  }
  function draw(){
    visibility();status.textContent=error||(data?'':'正在同步主持信息…');status.hidden=!status.textContent;retry.hidden=!error;
    if(!data)return;
    const wanted=new Set(data.party.filter(m=>m.character.portrait?.status==='ready').map(m=>'portrait:'+m.id+':'+m.character.portrait.id+':'+m.character.portrait.contentHash));
    if(data.board)wanted.add('map:'+data.board.map.id+':'+data.board.map.version+':'+data.board.map.contentHash);
    for(const [key,item] of media)if(!wanted.has(key)){if(item.url)URL.revokeObjectURL(item.url);media.delete(key);}
    const next=JSON.stringify([data,[...media].map(([key,item])=>[key,item.url,item.error])]);if(next===signature)return;signature=next;
    const top=body.scrollTop,focused=document.activeElement?.dataset?.dmMember,mapFocused=document.activeElement===mapButton;
    const opened=new Set([...body.querySelectorAll('details')].filter(d=>d.open).map(d=>d.querySelector('summary')?.textContent));
    const waiting=data.party.filter(m=>m.review?.status==='pending').length;
    body.replaceChildren(h('section.ov-sec',{},h('div.sec-h',{},h('span',{},'队伍 · '+data.party.length),waiting?h('em',{},waiting+' 名待审核'):null),
        ...data.party.map(memberCard),!data.party.length?h('p.small.muted',{},'尚无角色加入；主持席位不需要角色。'):null),
      sceneBlock(),mapBlock());
    for(const d of body.querySelectorAll('details'))if(opened.has(d.querySelector('summary')?.textContent))d.open=true;
    body.scrollTop=top;
    if(focused)[...body.querySelectorAll('[data-dm-member]')].find(b=>b.dataset.dmMember===focused)?.focus({preventScroll:true});
    if(mapFocused&&mapButton.isConnected)mapButton.focus({preventScroll:true});
    motion.stop();
    for(const member of body.querySelectorAll('.pc'))for(const selector of ['.dm-vitals','.dm-temp','.dm-resources']){
      const node=member.querySelector(selector),key=member.dataset.member+selector,text=node?.textContent||'';
      if(node&&animateValues&&!element.hidden&&values.has(key)&&values.get(key)!==text)motion(node,'change');
      values.set(key,text);
    }
    animateValues=false;
    drawMapWindow();
  }
  async function load(retryRead=false){
    const snapshot=ctx.snapshot,key=stamp(snapshot);
    if(!host()){generation++;pendingKey='';clear();visibility();return;}
    if(scope(snapshot)!==context){context=scope(snapshot);generation++;pendingKey='';failedKey='';error='';clear();}
    if(pendingKey===key||failedKey===key&&!retryRead)return;
    if(data&&data.version!==snapshot.version){data=null;signature='';body.replaceChildren();windowState?.close();windowState=null;}
    const own=++generation;pendingKey=key;error='';draw();
    const current=()=>host()&&own===generation&&key===stamp(ctx.snapshot);
    try{
      const value=await ctx.read('dm-overview');if(!current())return;
      if(value.campaignId!==snapshot.id)throw Error('主持概览不属于当前战役。');
      if(value.timelineId!==(snapshot.timelineId||'')||value.version>snapshot.version){clear();return;}
      if(value.version!==snapshot.version)throw Error('主持概览早于当前进度，请重新读取。');
      if(data?.board?.map.id!==value.board?.map.id){windowState?.close();windowState=null;}
      data=value;failedKey='';
    }catch(cause){if(current()){clear();error='主持信息读取失败：'+cause.message;failedKey=key;}}
    finally{if(own===generation){pendingKey='';if(current())draw();}}
  }
  visibility();
  return {element,mapButton,toggle,load,update:({live=true}={})=>{animateValues=live;return load();},setBlocked:value=>{blocked=value;visibility();}};
}
