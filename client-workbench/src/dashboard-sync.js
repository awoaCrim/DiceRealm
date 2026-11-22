import {h} from './dom.js';

// Read-only, one request at a time. A failure stops polling until an explicit retry.
export function watchDashboard(mount,connection,onSnapshot,{schedule=setTimeout,cancel=clearTimeout,delay=2500}={}){
  let disposed=false,loading=false,timer=null,resumed=false;
  const message=h('span'),retry=h('button.btn.btn-ghost',{type:'button',hidden:true,onclick:()=>poll()},'重新连接看板');
  const status=h('div.dashboard-sync',{role:'status'},message,retry);mount.append(status);
  // A background tab skips its turn and resumes within one interval of becoming visible.
  function later(){if(!disposed)timer=schedule(()=>{timer=null;if(globalThis.document?.hidden)later();else poll();},delay);}
  async function poll(){
    if(disposed||loading)return;
    if(timer!=null){cancel(timer);timer=null;}
    loading=true;retry.disabled=true;
    try{
      const value=await connection.snapshot();if(disposed)return;
      if(value)onSnapshot(value,{live:!resumed});resumed=false;
      message.textContent='已同步';retry.hidden=true;later();
    }catch(error){if(!disposed){resumed=true;message.textContent='实时同步已暂停：'+error.message;retry.hidden=false;}}
    finally{loading=false;if(!disposed)retry.disabled=false;}
  }
  mount.addEventListener('dispose',()=>{disposed=true;if(timer!=null)cancel(timer);},{once:true});
  message.textContent='自动同步中';later();
  return {poll};
}
