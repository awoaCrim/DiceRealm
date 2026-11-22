import {h,card} from './dom.js';
import {newUuid} from './api.js';

// Explicit adoption uses the same pending journal as manual setup. Browsing is read-only.
export async function renderAdventureLibrary(mount,ctx){
  if(!ctx.snapshot.party?.isHost)return;
  const scope=ctx.scope,version=ctx.snapshot.version;
  let disposed=false,loading=false,submitting=false,settled=false;
  const current=()=>!disposed&&ctx.scope===scope;
  const status=h('p',{role:'status'}),items=h('div.world-grid');
  const retry=h('button.btn',{type:'button',hidden:true,onclick:load},'重新读取剧本库');
  const hint=h('span.hint',{},'选择随附剧本；自己的剧本可在「手动导入」页签导入。');
  const section=card('','',h('h3',{},'剧本库',hint),items,status,retry);
  mount.append(section);
  mount.addEventListener('dispose',()=>{disposed=true;},{once:true});
  async function load(){
    if(!current()||loading||submitting||settled)return;
    loading=true;retry.disabled=true;status.textContent='正在读取剧本库…';
    try{
      const library=await ctx.read('content/library');if(!current())return;
      items.replaceChildren();status.textContent=library.notice;retry.hidden=true;
      // Import only exists before first setup; an adopted room can just browse.
      hint.textContent=library.canActivate?'选择随附剧本；自己的剧本可在「手动导入」页签导入。':'浏览随附剧本的简介。';
      if(!library.adventures.length)items.append(h('p.muted',{},'尚未安装剧本，仍可使用手动导入。'));
      for(const entry of library.adventures){
        const button=library.canActivate?h('button.btn.btn-primary',{
          type:'button','data-write':'true',disabled:!!ctx.hasPending?.(),
          onclick:()=>activate(entry)
        },'启用《'+entry.name+'》'):null;
        items.append(h('section.world-record',{},h('h3',{},entry.name),h('p',{},entry.summary),
          h('p.small',{},`${entry.levels} · ${entry.duration} · ${entry.sceneCount} 个地点 · ${entry.mapCount} 张原图`),
          ...(button?[h('div.btn-row',{},button)]:[])));
      }
    }catch(error){if(current()){status.textContent='剧本库读取失败：'+error.message;retry.hidden=false;}}
    finally{loading=false;if(current())retry.disabled=false;}
  }
  async function activate(entry){
    if(!current()||submitting||settled||ctx.hasPending?.()||ctx.snapshot.archived)return;
    if(ctx.snapshot.version!==version){status.textContent='房间状态已更新，请重新打开本页后选择。';return;}
    submitting=true;for(const button of items.querySelectorAll('button'))button.disabled=true;
    try{
      await ctx.submit('content/library/activate',{requestId:newUuid(),expectedVersion:version,libraryId:entry.id,hash:entry.hash});
      settled=true;if(!current())return;
      // Refreshing re-renders this page, so the confirmation goes to the page-level notice.
      if(await ctx.refresh()!==false)ctx.notify?.('已启用《'+entry.name+'》。');
    }catch(error){if(current())status.textContent=(settled?'已启用，但刷新失败：':'')+error.message;}
    finally{submitting=false;if(current())for(const button of items.querySelectorAll('button'))button.disabled=settled||!!ctx.hasPending?.();}
  }
  await load();
}
