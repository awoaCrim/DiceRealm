// A character the host returned (docs/room-onboarding.md): read the host's reason, optionally rebuild
// it in the full builder (a never-approved character may be replaced), and send it back with a note,
// which the server requires. The seat, its token and its identity stay; only the host can approve.
import {h} from '../dom.js';
import {ruleName} from '../rule-labels.js';
import {openBuilder} from './builder.js';

export function createResubmit({dialogs,read,send}){
  // Kept across the builder round trip: the note so far, the builder's draft, and an adopted rebuild.
  let state=null;
  const summary=ch=>[ch?.name,[ruleName(ch?.className||''),ch?.level?ch.level+' 级':''].filter(Boolean).join(' ')].filter(Boolean).join(' · ');

  function open(snapshot,review){
    if(state?.revision!==review.revision)state={revision:review.revision,note:'',draft:null,build:null,character:null,error:''};
    dialogs.open({title:'重新提交审核',wide:false,render:({body,close})=>{
      const note=h('textarea.pl-resubmit-note',{rows:4,maxlength:1000,placeholder:'说明这次改了什么，或回应主持的意见（必填）'});
      note.value=state.note;
      // The page's durable request reports the outcome; a refusal keeps this note for the next try, a
      // success moves the review to a new revision, which starts afresh.
      const submit=h('button.btn.btn-primary',{type:'button',onclick:()=>{
        if(!note.value.trim())return;
        state.note=note.value;close();
        send({revision:state.revision,submission:note.value.trim(),build:state.build});
      }},'提交审核');
      const sync=()=>{state.note=note.value;submit.disabled=!note.value.trim();};
      note.addEventListener('input',sync);sync();
      const rebuilt=state.build?h('p.pl-resubmit-new',{},'修改后：'+summary(state.character)):null;
      body.append(...[
        h('p.pl-resubmit-reason',{},h('b',{},'主持的意见'),review.reason||'（没有写明）'),
        h('section.pl-resubmit-part',{},h('h4',{},'角色'),h('p',{},'当前：'+summary(snapshot.character)),rebuilt,
          h('div.pl-resubmit-row',{},
            h('button.btn',{type:'button',onclick:()=>{state.note=note.value;close();void rebuild(snapshot,review);}},state.build?'继续修改角色':'修改角色…'),
            state.build?h('button.btn.btn-ghost',{type:'button',onclick:()=>{state.build=null;state.character=null;state.note=note.value;close();open(snapshot,review);}},'撤销修改'):null),
          h('p.small.muted',{},'不修改角色时，只把说明交给主持；修改后整张角色卡会替换为新的构筑。')),
        h('label.pl-resubmit-part',{},h('h4',{},'提交说明'),note),
        state.error?h('p.error-box',{role:'alert'},state.error):null,
        h('div.pl-resubmit-row.pl-resubmit-actions',{},submit,h('button.btn.btn-ghost',{type:'button',onclick:()=>{state.note=note.value;close();}},'取消'))].filter(Boolean));
    }});
  }

  // The builder is a full page above the adventure; it starts from the current character's build.
  async function rebuild(snapshot,review){
    let catalog;
    state.error='';
    try{catalog=await read('build-catalog');}
    catch(e){state.error='暂时无法读取建卡规则：'+e.message;open(snapshot,review);return;}
    const current=snapshot.character?.build;
    const saved=state.draft||(current&&current.revision===catalog.revision?{build:structuredClone(current),step:0}:null);
    const layer=h('div.pl-rebuild');
    document.body.append(layer);
    openBuilder(layer,{catalog,saved,
      evaluate:value=>read('build-evaluate',{build:value}),
      onSave:value=>{state.draft=value;},
      onClose:()=>{layer.remove();open(snapshot,review);},
      onAdopt:(build,character)=>{state.build=build;state.character=character;layer.remove();open(snapshot,review);}});
  }
  return {open};
}
