// 地图图册：只读浏览 + 主持用途/比例尺校准，以及当前场景共享地图的显式选择。
// 图片字节走既有鉴权 API，绝不使用带令牌的 URL；浏览、取点读图都不提交、不生成、不改比例。
// 用途只是分类，不决定每格距离；比例依据不随用途改变，也不按图片尺寸或图内物体推断。
import {h,errorBox} from './dom.js';
import {newUuid} from './api.js';
import {draftKey,readDraft,writeDraft,clearDraft} from './drafts.js';

const purposes=[['','未记录（保持）'],['region','区域'],['settlement','城镇'],['tactical','局部战术'],['schematic','示意']];
const basisKinds=[['','未记录'],['source','原资料标注'],['dm','主持本场设定'],['unknown','尚未确定']];
const gridTypes=[['none','无网格'],['square','方格'],['hex','六角格（平顶）']];
const unitChoices=[['feet','英尺'],['miles','英里'],['meters','米'],['kilometers','千米']];
const purposeNames={region:'区域',settlement:'城镇',tactical:'局部战术',schematic:'示意'};
const unitNames={feet:'英尺',miles:'英里',meters:'米',kilometers:'千米'};
const controlChars=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const choice=(options,selected)=>{
  const select=h('select',{},...options.map(([value,text])=>h('option',{value},text)));
  select.value=String(selected??'');return select;
};
const svg=(tag,attrs={})=>{
  const element=document.createElementNS('http://www.w3.org/2000/svg',tag);
  for(const [key,value] of Object.entries(attrs))element.setAttribute(key,String(value));
  return element;
};
function parsedDraft(key){try{return JSON.parse(readDraft(key)||'null');}catch{return null;}}
export function confirmMapGridDraft(scope,payload){
  if(!payload?.mapId||!payload.mapDraftRevision)return;
  const key=draftKey(scope,`map-grid:${payload.mapId}`),state=parsedDraft(key);
  if(state?.revision===payload.mapDraftRevision&&state.baseVersion===payload.expectedVersion)clearDraft(key);
}
const field=(text,control)=>h('label.f',{},h('span',{},text),control);

/** 只显示已保存的元数据；字段缺失说明未记录，不按用途、分类或图片尺寸补默认值。 */
export function gridScaleText(grid){
  if(!grid)return '比例未记录';
  if(grid.uncalibrated===true||grid.scaleBasis?.kind==='unknown')return '比例未校准 · 禁止精确测距';
  if(!finite(grid.cellPixels)||grid.cellPixels<=0||!finite(grid.distance)||grid.distance<=0||!Object.hasOwn(unitNames,grid.units))return '比例未记录';
  return `每 ${grid.cellPixels} 像素 = ${grid.distance} ${unitNames[grid.units]||grid.units||''}`.trim();
}

export async function renderMapReader(mount,ctx){
  if(!ctx.snapshot.party?.isHost)return;
  let disposed=false,generation=0,editorGeneration=0,imageUrl='',loadedHash='',library=null,shown=null,natural=null,applying=false,picking=false,onPick=null,syncEditorState=()=>{};
  const status=h('p.small',{'role':'status'}),choices=h('nav.atlas-choices',{'aria-label':'地图列表'}),picture=h('div.atlas-picture',{tabindex:'0','aria-label':'地图图片，可滚动查看'}),details=h('p.small.muted'),editor=h('div');
  const blocked=()=>ctx.hasPending?.()===true;
  const archived=()=>ctx.snapshot.archived===true;

  function clearImage(){
    picture.replaceChildren();
    if(imageUrl)URL.revokeObjectURL(imageUrl);
    imageUrl='';loadedHash='';natural=null;details.textContent='';size.hidden=true;
  }
  mount.addEventListener('dispose',()=>{disposed=true;generation++;picking=false;onPick=null;clearImage();},{once:true});

  const info=(map)=>{
    const edition=map.edition==='gm'?'主持版 · 不向玩家公开':map.published?'玩家版 · 已公开':'玩家版 · 未公开';
    const provenance=map.provenance?.kind==='generated_schematic'?'扩展示意 · 非原版地理':map.provenance?.kind==='imported_original'||map.importSource?'导入原图':'来源未记录';
    return [edition,`${map.width} × ${map.height}`,provenance,gridScaleText(map.grid),
      map.provenance?.referenceMode==='description'?'文字风格参考（未上传原图）':null,
      map.purpose?`用途：${purposeNames[map.purpose]||map.purpose}`:null,
      map.id===library?.selectedMapId?'当前玩家端地图':null].filter(Boolean).join(' · ');
  };

  // 点击图片取点：按图片自然像素计算；显示尺寸与自然尺寸不一致时按比例换算，不写任何坐标。
  function naturalPoint(event,map){
    const image=picture.querySelector('img');
    if(!image||typeof image.getBoundingClientRect!=='function'){status.textContent='图片尚未显示，无法在图上取点。';return null;}
    const rect=image.getBoundingClientRect();
    const width=Number(natural?.width)>0?Number(natural.width):Number(map.width);
    const height=Number(natural?.height)>0?Number(natural.height):Number(map.height);
    if(!(rect.width>0)||!(rect.height>0)||!(width>0)||!(height>0)){status.textContent='图片尺寸不可用，无法在图上取点。';return null;}
    const x=(Number(event.clientX)-rect.left)*width/rect.width;
    const y=(Number(event.clientY)-rect.top)*height/rect.height;
    if(!finite(x)||!finite(y))return null;
    return {x,y};
  }

  function renderEditor(map){
    const currentEditor=++editorGeneration;
    let settled=false,revision=newUuid(),remembered=false;
    const active=()=>!disposed&&!settled&&currentEditor===editorGeneration&&(!remembered||!!readDraft(key));
    picking=false;onPick=null;
    const key=draftKey(ctx.scope,`map-grid:${map.id}`);
    const grid=map.grid||{};
    let draft=null;
    const raw=readDraft(key);remembered=!!raw;
    if(raw){try{draft=JSON.parse(raw);}catch{/* 损坏的内存草稿不作为数据使用。 */}}
    const state=draft&&typeof draft==='object'?draft:null;
    const saved=name=>state&&Object.hasOwn(state,name)?state[name]:undefined;
    const baseVersion=Number.isInteger(state?.baseVersion)?state.baseVersion:map.version;
    const stale=baseVersion!==map.version;

    const purposeField=choice(purposes,saved('purpose')===undefined?map.purpose??'':saved('purpose'));
    const typeField=choice(gridTypes,saved('type')===undefined?grid.type??'none':saved('type'));
    const cellPixelsField=h('input',{type:'number',step:'any',min:'16',max:'2048','aria-label':'每格像素',value:saved('cellPixels')===undefined?grid.cellPixels??'':saved('cellPixels')});
    const offsetXField=h('input',{type:'number',step:'any',min:'-8192',max:'8192','aria-label':'偏移 X（像素）',value:saved('offsetX')===undefined?grid.offsetX??0:saved('offsetX')});
    const offsetYField=h('input',{type:'number',step:'any',min:'-8192',max:'8192','aria-label':'偏移 Y（像素）',value:saved('offsetY')===undefined?grid.offsetY??0:saved('offsetY')});
    const distanceField=h('input',{type:'number',step:'any',min:'0','aria-label':'每格实际距离',value:saved('distance')===undefined?grid.distance??'':saved('distance')});
    const unitsField=choice(unitChoices,saved('units')===undefined?grid.units??'feet':saved('units'));
    const basisKindField=choice(basisKinds,saved('basisKind')===undefined?grid.scaleBasis?.kind??'':saved('basisKind'));
    const basisDetailField=h('input',{type:'text',maxLength:500,'aria-label':'比例依据说明',value:saved('basisDetail')===undefined?grid.scaleBasis?.detail??'':saved('basisDetail')});
    const uncalibratedField=h('input',{type:'checkbox','aria-label':'标为未校准',...(saved('uncalibrated')===undefined?{checked:grid.uncalibrated===true}:{checked:saved('uncalibrated')===true})});
    const actualField=h('input',{type:'number',step:'any',min:'0','aria-label':'两点间实际长度',value:saved('actual')??''});
    const actualUnitsField=choice(unitChoices,saved('actualUnits')===undefined?grid.units??'feet':saved('actualUnits'));
    let points=Array.isArray(saved('points'))?saved('points').filter(p=>finite(p?.x)&&finite(p?.y)).slice(0,2):[];

    const pointOutput=h('output.small',{},'');
    const editorStatus=h('div',{'aria-live':'polite'});
    const saveButton=h('button.btn.btn-primary',{type:'button','data-write':'true',onclick:()=>save()},'保存用途与比例尺');
    const publishButton=h('button.btn',{type:'button','data-write':'true',onclick:()=>publish()},map.published?'重新发布给玩家':'发布给玩家');
    const rebaseButton=h('button.btn',{type:'button',onclick:()=>{if(!active()||applying)return;clearDraft(key);renderEditor(map);}},'放弃草稿并载入当前记录');
    const selectButton=h('button.btn',{type:'button','data-write':'true',onclick:()=>selectCurrent()},'设为当前地图');
    const pickButton=h('button.btn',{type:'button',onclick:()=>togglePick()},'在图上取点');
    const clearPointsButton=h('button.btn.btn-ghost',{type:'button',onclick:()=>{if(!active()||applying)return;points=[];picking=false;onPick=null;sync();drawPoints();}},'清除取点');
    const gridPreview=h('input',{type:'checkbox','aria-label':'显示网格对齐'});
    const calcButton=h('button.btn',{type:'button',onclick:()=>calcFromPoints()},'按两点计算比例');

    const eligible=map.currentScene===true&&map.status==='ready'&&map.published===true&&map.edition==='player';
    const selected=library?.selectedMapId===map.id;
    const publishable=map.edition==='player'&&map.status==='ready'&&!!map.imageUrl;
    const permanent={
      save:archived(),
      publish:archived()||!publishable||map.published===true,
      select:archived()||!eligible||selected
    };
    for(const [button,name] of [[saveButton,'save'],[publishButton,'publish'],[selectButton,'select']]){
      button.dataset.disabledBase=String(permanent[name]);
      button.disabled=permanent[name];
    }
    publishButton.hidden=!publishable||map.published===true;
    selectButton.hidden=!eligible||selected;

    function controls(){
      for(const button of [saveButton,publishButton,selectButton,pickButton,clearPointsButton,calcButton,rebaseButton])button.disabled=applying;
      for(const [name,button] of [['save',saveButton],['publish',publishButton],['select',selectButton]])if(permanent[name])button.disabled=true;
    }
    function sync(){
      if(!active())return;
      revision=newUuid();remembered=true;
      writeDraft(key,JSON.stringify({baseVersion,revision,
        purpose:purposeField.value,type:typeField.value,cellPixels:cellPixelsField.value,offsetX:offsetXField.value,offsetY:offsetYField.value,
        distance:distanceField.value,units:unitsField.value,basisKind:basisKindField.value,basisDetail:basisDetailField.value,
        uncalibrated:uncalibratedField.checked===true,actual:actualField.value,actualUnits:actualUnitsField.value,points:[...points]}));
    }
    function format(value){return Math.round(value*10)/10;}
    const looksImageReady=()=>!!natural||!!picture.querySelector('img');
    function drawPoints(){
      if(!active())return;
      drawOverlay();
      const parts=[];
      if(points.length)parts.push(points.map((p,index)=>`取点 ${index+1}：(${format(p.x)}, ${format(p.y)}) 像素`).join('　'));
      else parts.push('尚未取点。');
      if(points.length===2){
        const span=spanPixels(points);
        parts.push(span?`两点图上直线距离 ${format(span)} 像素。`:'两点重合，请重新取点。');
      }else if(picking)parts.push(`请在图片上点选第 ${points.length+1} 个点。`);
      pointOutput.textContent=parts.join(' ');
      pickButton.textContent=picking?'取消取点':'在图上取点';
      clearPointsButton.disabled=applying||points.length===0;
      pickButton.disabled=applying||!looksImageReady();
    }
    function drawOverlay(){
      const stage=picture.querySelector('.atlas-image-stage');if(!stage)return;
      stage.querySelector('svg')?.remove();
      const width=Number(natural?.width||map.width),height=Number(natural?.height||map.height);
      if(!(width>0&&height>0))return;
      const overlay=svg('svg',{viewBox:`0 0 ${width} ${height}`,class:'atlas-calibration-overlay','aria-hidden':'true'});
      const cell=Number(cellPixelsField.value);
      if(gridPreview.checked&&typeField.value==='square'&&cell>=16&&cell<=2048){
        const patternId=`atlas-grid-${currentEditor}`,defs=svg('defs'),pattern=svg('pattern',{id:patternId,patternUnits:'userSpaceOnUse',x:Number(offsetXField.value)||0,y:Number(offsetYField.value)||0,width:cell,height:cell});
        pattern.append(svg('path',{d:`M ${cell} 0 H 0 V ${cell}`,class:'atlas-grid-line','vector-effect':'non-scaling-stroke'}));defs.append(pattern);
        overlay.append(defs,svg('rect',{width,height,fill:`url(#${patternId})`}));
      }
      if(points.length===2)overlay.append(svg('line',{x1:points[0].x,y1:points[0].y,x2:points[1].x,y2:points[1].y,class:'atlas-calibration-line','vector-effect':'non-scaling-stroke'}));
      for(const [index,point] of points.entries()){
        overlay.append(svg('circle',{cx:point.x,cy:point.y,r:width*.009,class:'atlas-calibration-point','vector-effect':'non-scaling-stroke'}));
        const label=svg('text',{x:point.x,y:point.y,'text-anchor':'middle','dominant-baseline':'central','font-size':width*.014,class:'atlas-calibration-label'});
        label.textContent=String(index+1);overlay.append(label);
      }
      stage.append(overlay);
    }
    function updateBasis(){
      if(!active())return;
      const unknown=basisKindField.value==='unknown';
      if(unknown)uncalibratedField.checked=true;
      uncalibratedField.disabled=applying||unknown;
    }
    function togglePick(){
      if(!active()||applying)return;
      if(!looksImageReady()){editorStatus.replaceChildren(errorBox('请先读取该地图的图片，再在图上取点。'));return;}
      picking=!picking;onPick=picking?event=>addPoint(event):null;drawPoints();
    }
    function addPoint(event){
      if(!active()||applying)return;
      if(points.length>=2){editorStatus.replaceChildren(errorBox('已取满两点，请先清除取点。'));return;}
      const point=naturalPoint(event,map);if(!point)return;
      points.push(point);
      if(points.length>=2){picking=false;onPick=null;}
      sync();drawPoints();
    }
    function spanPixels(list){
      if(list.length<2)return null;
      const span=Math.hypot(list[1].x-list[0].x,list[1].y-list[0].y);
      return finite(span)&&span>0?span:null;
    }
    // 两点换算只得到实际像素比例：原有网格保留格距与偏移，只改每格实际距离；无网格才用像素跨度当格距。
    function calcFromPoints(){
      if(!active()||applying)return;
      const span=spanPixels(points);
      if(!span){editorStatus.replaceChildren(errorBox('请先在图片上取满两个不重合的点。'));return;}
      if(basisKindField.value==='unknown'){editorStatus.replaceChildren(errorBox('比例依据为「尚未确定」时不能标为已校准；请选择依据或留空后重算。'));return;}
      const actual=Number(actualField.value);
      if(!finite(actual)||actual<=0){editorStatus.replaceChildren(errorBox('请填写两点之间的实际长度（大于 0 的数字）。'));return;}
      let cellPixels,distance;
      // 表单里已填的原网格格距优先保留；只有无网格或格距未填时才用这次实测的像素跨度当格距。
      const declaredType=typeField.value,declaredCell=Number(cellPixelsField.value);
      if((declaredType==='square'||declaredType==='hex')&&finite(declaredCell)&&declaredCell>=16&&declaredCell<=2048){
        cellPixels=declaredCell;distance=actual*declaredCell/span;
      }else{
        const factor=span<16?16/span:span>2048?2048/span:1;
        cellPixels=span*factor;distance=actual*factor;
      }
      if(!finite(distance)||distance<=0||distance>1000000){
        editorStatus.replaceChildren(errorBox('这个长度换算的每格距离超出可保存范围（最多 1000000）；请改用更合适的单位或更短的实测距离。'));
        return;
      }
      cellPixelsField.value=String(cellPixels);distanceField.value=String(distance);
      unitsField.value=actualUnitsField.value;uncalibratedField.checked=false;
      sync();drawPoints();updateBasis();
      editorStatus.replaceChildren(h('p.small',{},`已按两点换算：每 ${cellPixels} 像素 = ${distance} ${unitNames[actualUnitsField.value]||actualUnitsField.value}。核对后保存。`));
    }
    function collect(){
      const number=(el,empty)=>el.value===''?empty:Number(el.value);
      let scaleBasis=null;
      if(basisKindField.value){
        const detail=basisDetailField.value.trim();
        if(!detail)throw new Error('选择比例依据后请填写说明（1–500 字）。');
        if(detail.length>500)throw new Error('比例依据说明最多 500 字。');
        if(controlChars.test(detail))throw new Error('比例依据说明不能包含控制字符。');
        scaleBasis={kind:basisKindField.value,detail};
      }
      const body={type:typeField.value,cellPixels:number(cellPixelsField,NaN),offsetX:number(offsetXField,0),offsetY:number(offsetYField,0),
        distance:number(distanceField,NaN),units:unitsField.value,uncalibrated:basisKindField.value==='unknown'?true:uncalibratedField.checked===true};
      if(scaleBasis)body.scaleBasis=scaleBasis;
      if(!finite(body.cellPixels)||body.cellPixels<16||body.cellPixels>2048)throw new Error('每格像素须为 16 至 2048 之间的数字。');
      if(!finite(body.offsetX)||Math.abs(body.offsetX)>8192||!finite(body.offsetY)||Math.abs(body.offsetY)>8192)throw new Error('偏移须为 -8192 至 8192 之间的数字。');
      if(!finite(body.distance)||body.distance<=0||body.distance>1000000)throw new Error('每格实际距离须为大于 0 且不超过 1000000 的数字。');
      return {purpose:purposeField.value||null,grid:body};
    }

    async function save(){
      if(!active()||applying)return;
      if(blocked()){editorStatus.replaceChildren(errorBox('有未确认操作，请先在上方重试原请求。'));return;}
      if(archived()){editorStatus.replaceChildren(errorBox('战役已归档，不能再保存地图比例。'));return;}
      let body;
      try{body=collect();}catch(error){editorStatus.replaceChildren(errorBox(error.message));return;}
      sync();
      const payload={mapId:map.id,expectedVersion:baseVersion,grid:body.grid,purpose:body.purpose,mapDraftRevision:revision};
      applying=true;controls();editorStatus.replaceChildren();
      let accepted=false;
      try{
        await ctx.submit('maps-grid',payload);
        accepted=true;confirmMapGridDraft(ctx.scope,payload);
        if(disposed||currentEditor!==editorGeneration)return;
        settled=true;
        await load();
        if(!disposed)status.textContent='已保存；检查网格后重新发布给玩家。';
      }catch(error){
        if(!disposed&&currentEditor===editorGeneration)editorStatus.replaceChildren(errorBox((accepted?'已保存，但刷新失败：':'')+error.message));
      }
      finally{applying=false;syncEditorState();}
    }
    async function publish(){
      if(!active()||applying||!publishable)return;
      if(blocked()){editorStatus.replaceChildren(errorBox('有未确认操作，请先在上方重试原请求。'));return;}
      if(archived()){editorStatus.replaceChildren(errorBox('战役已归档，不能发布地图。'));return;}
      applying=true;controls();editorStatus.replaceChildren();
      let accepted=false;
      try{
        await ctx.submit('maps-publish',{mapId:map.id,expectedVersion:map.version,published:true,confirmPlayerVisibility:true});
        accepted=true;
        if(!active())return;
        await load();
        if(!disposed)status.textContent='已发布给玩家。';
      }catch(error){if(active())editorStatus.replaceChildren(errorBox((accepted?'已发布，但刷新失败：':'')+error.message));}
      finally{applying=false;syncEditorState();}
    }
    async function selectCurrent(){
      if(!active()||applying||!eligible||selected)return;
      if(blocked()){editorStatus.replaceChildren(errorBox('有未确认操作，请先在上方重试原请求。'));return;}
      if(archived()){editorStatus.replaceChildren(errorBox('战役已归档，不能切换当前地图。'));return;}
      applying=true;controls();editorStatus.replaceChildren();
      let accepted=false;
      try{
        await ctx.submit('maps-select',{mapId:map.id,expectedVersion:ctx.snapshot.version,expectedMapVersion:map.version});
        accepted=true;
        if(!active())return;
        await ctx.refresh();
      }catch(error){if(active())editorStatus.replaceChildren(errorBox((accepted?'已切换，但刷新失败：':'')+error.message));}
      finally{applying=false;syncEditorState();}
    }

    const shareText=selected?'当前玩家端地图':eligible?'可切换为当前玩家端地图；各图保留各自的单位位置。':
      map.currentScene!==true?'未关联当前场景。':map.edition==='gm'?'主持版仅自己可见。':'发布玩家版后可设为当前地图。';
    const recalibration=stale?h('div',{},h('p.small.warning-text',{},`这份草稿基于地图版本 ${baseVersion}，当前已是版本 ${map.version}；不会自动改用新版本。重新读取图册并核对后再保存，或按当前版本重填。`),h('div.btn-row',{},rebaseButton)):null;

    editor.replaceChildren(
      h('p.small',{},shareText),h('div.btn-row',{},selectButton,publishButton),
      h('fieldset',{},h('legend',{},'用途与比例尺'),
        h('div.atlas-fields',{},field('地图用途',purposeField),field('比例依据',basisKindField)),
        field('依据说明（公开，1–500 字）',basisDetailField),
        h('label.check',{},uncalibratedField,h('span',{},'未校准 · 禁止精确测距')),
        h('details',{},h('summary',{},'网格对齐与距离'),
          h('div.atlas-fields',{},field('网格类型',typeField),field('距离单位',unitsField),
            field('每格像素',cellPixelsField),field('每格实际距离',distanceField),
            field('偏移 X（像素）',offsetXField),field('偏移 Y（像素）',offsetYField)),
          h('label.check',{},gridPreview,h('span',{},'显示方格对齐'))),
        h('details',{open:true},h('summary',{},'两点校准'),
          h('p.small',{},'点选两点，填写已知实际长度。原网格的格距与偏移保持不变。'),
          h('div.btn-row',{},pickButton,clearPointsButton),pointOutput,
          h('div.atlas-fields',{},field('两点间实际长度',actualField),field('长度单位',actualUnitsField)),
          h('div.btn-row',{},calcButton)),
        h('div.btn-row',{},saveButton),
        h('p.small.muted',{},`基于版本 ${baseVersion}。保存后须重新发布给玩家。`),
        recalibration,editorStatus));

    uncalibratedField.addEventListener('change',()=>{sync();updateBasis();});
    for(const control of [purposeField,typeField,cellPixelsField,offsetXField,offsetYField,distanceField,unitsField,basisKindField,basisDetailField,actualField,actualUnitsField]){
      control.addEventListener('input',sync);
      control.addEventListener('change',sync);
    }
    basisKindField.addEventListener('change',updateBasis);
    gridPreview.addEventListener('change',()=>{if(active())drawOverlay();});
    for(const control of [typeField,cellPixelsField,offsetXField,offsetYField])control.addEventListener('input',()=>{if(active())drawOverlay();});
    syncEditorState=()=>{if(active()){controls();drawPoints();updateBasis();}};
    updateBasis();controls();drawPoints();
  }

  async function show(map){
    if(disposed)return;
    const request=++generation,previous=shown;
    // 同一张图未变化时保留已读像素与查看缩放，不重复下载；元数据仍重新显示。
    const reuse=!!imageUrl&&previous?.id===map.id&&!!map.contentHash&&map.contentHash===loadedHash;
    if(!reuse)clearImage();
    editor.replaceChildren();shown=map;
    status.textContent=reuse?map.title:'正在读取地图…';
    for(const button of choices.querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.mapId===map.id));
    details.textContent=info(map);
    renderEditor(map);
    if(map.status!=='ready'){status.textContent=`${map.title} · 尚无可读取图片（${map.status}）；仍可先保存用途与比例尺。`;return;}
    if(reuse){syncEditorState();return;}
    try{
      const blob=await ctx.read('map-image',{mapId:map.id});
      if(disposed||request!==generation)return;
      imageUrl=URL.createObjectURL(blob);
      const image=h('img',{src:imageUrl,alt:map.title,onclick:event=>{if(picking&&onPick)onPick(event);}});
      natural={width:Number(image.naturalWidth)>0?image.naturalWidth:map.width,height:Number(image.naturalHeight)>0?image.naturalHeight:map.height};
      image.addEventListener('load',()=>{if(disposed||request!==generation)return;if(Number(image.naturalWidth)>0)natural={width:image.naturalWidth,height:image.naturalHeight};syncEditorState();});
      picture.append(h('div.atlas-image-stage',{},image));size.hidden=false;loadedHash=map.contentHash||'';
      syncEditorState();
      status.textContent=map.title;
    }catch(error){if(!disposed&&request===generation){clearImage();status.textContent='地图读取失败：'+error.message+'；可重新点击该地图重试。';}}
  }
  async function load(){
    if(disposed)return;
    const request=++generation;editorGeneration++;picking=false;onPick=null;clearImage();choices.replaceChildren();editor.replaceChildren();status.textContent='正在读取图册…';refresh.disabled=true;
    try{
      const result=await ctx.read('maps');
      if(disposed||request!==generation)return;
      library=result;
      // Keep each place's player and host editions next to each other.
      const maps=[...result.maps].sort((a,b)=>a.title.localeCompare(b.title,'zh')||(a.edition==='gm')-(b.edition==='gm'));
      status.textContent=maps.length?`共 ${maps.length} 张地图。选择后读取图片；浏览本身不生成、不发布、不切换当前地图。`
        :'当前房间还没有地图。启用带原图的剧本后地图会出现在这里；在 AI 设置开启地图图片服务后，AI 也会按需生成。';
      for(const map of maps){
        const button=h('button.btn.sheet-entry',{type:'button','aria-pressed':'false','aria-label':map.title+(map.edition==='gm'?' · 仅主持':'')+(map.id===result.selectedMapId?' · 当前':''),onclick:()=>show(map)},
          h('strong',{},map.title),h('span.small.muted',{},map.edition==='gm'?'主持版':map.published?'玩家版 · 已公开':'玩家版 · 未公开'),
          map.id===result.selectedMapId?h('span.status-tag',{'data-state':'ok'},'当前地图'):null);
        button.dataset.mapId=map.id;choices.append(button);
      }
      const again=shown&&maps.find(entry=>entry.id===shown.id);
      if(again)await show(again);
      else if(shown){shown=null;editor.replaceChildren();}
    }catch(error){if(!disposed&&request===generation)status.textContent='图册读取失败：'+error.message;}
    finally{if(!disposed)refresh.disabled=false;}
  }
  const refresh=h('button.btn',{type:'button',onclick:load},'重新读取图册');
  const size=h('button.btn',{type:'button','aria-pressed':'false',onclick:()=>{
    const full=picture.classList.toggle('atlas-native');size.setAttribute('aria-pressed',String(full));size.textContent=full?'适应宽度':'原始尺寸';
  }},'原始尺寸');
  mount.append(h('div.atlas-catalog',{},
    h('aside.atlas-index',{},h('h2',{},'地图目录'),choices,h('div.btn-row',{},refresh)),
    h('section.atlas-detail',{'aria-label':'地图详情'},status,h('div.btn-row',{},size),details,h('div.atlas-workspace',{},picture,editor))));
  await load();
}
