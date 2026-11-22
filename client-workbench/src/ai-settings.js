import {h,card,confirmDialog,pageHead} from './dom.js';
import {newUuid} from './api.js';

// Independent local-operator authority; never passes through campaign pending/session storage.
export function createOperatorApi({fetchImpl=fetch,accessToken=''}={}){
  const endpoint='/api/v1/operator/ai-settings';
  async function request(method,path='',body=null){
    let response;
    try{response=await fetchImpl(endpoint+path,{method,headers:{'X-DiceRealm-Local-Settings':'1',...(accessToken?{Authorization:'Bearer '+accessToken}:{}),...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body}:{}),cache:'no-store',credentials:'omit',redirect:'error'});}
    catch{throw Object.assign(Error('服务管理请求结果未确认，请保留当前页面并重试原请求。'),{unconfirmed:true});}
    let value;
    try{const raw=await response.text();if(raw.length>65536)throw Error();value=JSON.parse(raw);}
    catch{throw Object.assign(Error('服务管理响应不完整；不会自动重发。'),{unconfirmed:true});}
    if(!response.ok)throw Object.assign(Error(typeof value.message==='string'?value.message:'服务管理请求失败。'),{status:response.status,unconfirmed:![400,401,403,404,409,413,422].includes(response.status)});
    if(path.startsWith('/test')){
      const expectedId=body?JSON.parse(body).requestId:decodeURIComponent(path.slice('/tests/'.length));
      if(value?.requestId!==expectedId||!Number.isSafeInteger(value?.version)||!['main','helper'].includes(value?.role)||!['success','failed','unknown'].includes(value.status)||typeof value.message!=='string')throw Object.assign(Error('测试回执不完整。'),{unconfirmed:true});
    }else{
      const image=value?.image;
      if(!Number.isSafeInteger(value?.version)||!value.main||!value.helper||[value.main,value.helper].some(p=>typeof p.hasApiKey!=='boolean'||typeof p.enabled!=='boolean'||typeof p.model!=='string'||typeof p.baseUrl!=='string'||Object.hasOwn(p,'apiKey'))
        ||image!=null&&(typeof image.enabled!=='boolean'||typeof image.endpoint!=='string'||typeof image.editsEndpoint!=='string'||typeof image.model!=='string'
          ||typeof image.hasApiKey!=='boolean'||typeof image.allowReferenceUpload!=='boolean'||typeof image.sendResponseFormat!=='boolean'||Object.hasOwn(image,'apiKey')))
        throw Object.assign(Error('AI 配置响应不完整或包含不应返回的密钥。'),{unconfirmed:true});
    }
    if(method==='POST'&&path===''&&value.version!==JSON.parse(body).expectedVersion+1)throw Object.assign(Error('配置回执版本不匹配。'),{unconfirmed:true});
    return value;
  }
  return {read:()=>request('GET'),save:body=>request('POST','',body),test:body=>request('POST','/test',body),probe:id=>request('GET','/tests/'+encodeURIComponent(id))};
}

export function renderAiSettings(mount,ctx){
  let disposed=false,api=null,state=null,busy=false,dirty=false,verified=true,pending=null,probeId=null,drawGeneration=0,activeRole='main';
  const current=()=>!disposed;
  const message=h('p',{role:'status'}),editor=h('div');
  const reloadInitial=h('button.btn',{type:'button',onclick:connect},'重新读取 AI 配置');
  const panel=card('','',editor,reloadInitial,message);panel.classList.add('ai-settings-panel');
  mount.append(panel);
  mount.addEventListener('dispose',()=>{disposed=true;for(const field of editor.querySelectorAll('input[type="password"]'))field.value='';api=null;pending=null;},{once:true});
  async function connect(){
    if(busy||disposed)return;
    busy=true;reloadInitial.disabled=true;
    const candidate=createOperatorApi({accessToken:ctx.account?.accessToken||''});
    try{const value=await candidate.read();if(!current())return;api=candidate;state=value;reloadInitial.hidden=true;busy=false;draw();}
    catch(error){if(current())message.textContent=error.message;}
    finally{busy=false;if(current())reloadInitial.disabled=false;}
  }
  void connect();
  function draw(){
    const generation=++drawGeneration;
    editor.replaceChildren();dirty=false;
    const form=h('fieldset.ai-provider-grid'),fields={};
    const label=(text,input)=>h('label.f',{},h('span',{},text),input);
    const imageState=state.image??{enabled:false,endpoint:'',editsEndpoint:'',model:'',hasApiKey:false,allowReferenceUpload:false,sendResponseFormat:true};
    const save=h('button.btn.btn-primary',{type:'button',onclick:saveSettings},'保存 AI 配置');
    const retry=h('button.btn.btn-ghost',{type:'button',hidden:true,onclick:retryOriginal},'重试原请求');
    const readProbe=h('button.btn.btn-ghost',{type:'button',hidden:!probeId,onclick:readTest},'查看测试结果');
    const reload=h('button.btn.btn-ghost',{type:'button',onclick:reloadSettings},'重新读取配置');
    const tests=[];
    for(const [role,title] of [['main','DM 叙事主模型'],['helper','轻量辅助模型']]){
      const value=state[role],enabled=h('input',{type:'checkbox',checked:value.enabled,'aria-label':title+'启用'});
      const provider=h('select',{'aria-label':title+' Provider'},h('option',{value:'openai-chat'},'OpenAI-compatible Chat'),h('option',{value:'gemini'},'Gemini 原生'));provider.value=value.provider;
      const endpointMode=h('select',{'aria-label':title+'地址模式'},h('option',{value:'base'},'基础地址'),h('option',{value:'complete'},'完整 OpenAI Endpoint（兼容自定义代理）'));endpointMode.value=value.endpointIsComplete?'complete':'base';
      const baseUrl=h('input',{type:'text',value:value.baseUrl,maxLength:2048,placeholder:'https://…/v1','aria-label':title+' Base URL'});
      provider.addEventListener('change',()=>{if(provider.value==='gemini'){endpointMode.value='base';endpointMode.disabled=true;}else endpointMode.disabled=false;});
      endpointMode.disabled=provider.value==='gemini';
      const model=h('input',{type:'text',value:value.model,maxLength:256,'aria-label':title+'模型名称'});
      const keyAction=h('select',{'aria-label':title+'密钥操作'},h('option',{value:'keep'},value.hasApiKey?'保留已保存的密钥':'未配置密钥'),h('option',{value:'replace'},'设置新密钥'),h('option',{value:'clear'},'清除密钥'));
      const apiKey=h('input',{type:'password',autocomplete:'new-password',maxLength:8192,hidden:true,'aria-label':title+' API Key'});
      keyAction.addEventListener('change',()=>{apiKey.hidden=keyAction.value!=='replace';if(apiKey.hidden)apiKey.value='';});
      const testHint=h('p.hint',{id:'ai-test-'+role,role:'status'}),testResult=h('p',{role:'status'});
      const test=h('button.btn.btn-ghost',{type:'button','aria-label':'测试'+title+'连通性','aria-describedby':'ai-test-'+role,onclick:()=>testModel(role)},'测试连通');tests.push({test,testHint,testResult,role});
      form.append(h('section.ai-provider',{'data-ai-role':role},h('div.ai-provider-head',{},h('h4',{},title),h('label.check',{},enabled,'启用')),
        h('div.ai-field-row',{},label('接口协议',provider),label('模型名称',model)),
        h('div.ai-field-row',{},label('地址模式',endpointMode),label('接口地址',baseUrl)),label('密钥',keyAction),apiKey,
        h('div.ai-test',{},h('h5',{},'连通性'),testHint,test,testResult)));
      fields[role]={enabled,provider,baseUrl,model,keyAction,apiKey,endpointMode};
      for(const input of Object.values(fields[role]))for(const event of ['input','change'])input.addEventListener(event,update);
    }
    const imageTitle='地图图片服务';
    const enabled=h('input',{type:'checkbox',checked:imageState.enabled,'aria-label':imageTitle+'启用'});
    const endpoint=h('input',{type:'text',value:imageState.endpoint,maxLength:2048,placeholder:'https://api.example.com/v1/images/generations','aria-label':imageTitle+'生成接口'});
    const editsEndpoint=h('input',{type:'text',value:imageState.editsEndpoint,maxLength:2048,placeholder:'https://api.example.com/v1/images/edits','aria-label':imageTitle+'编辑接口'});
    const model=h('input',{type:'text',value:imageState.model,maxLength:256,placeholder:'gpt-image-2.5','aria-label':imageTitle+'模型名称'});
    const keyAction=h('select',{'aria-label':imageTitle+'密钥操作'},h('option',{value:'keep'},imageState.hasApiKey?'保留已保存的密钥':'未配置密钥'),h('option',{value:'replace'},'设置新密钥'),h('option',{value:'clear'},'清除密钥'));
    const apiKey=h('input',{type:'password',autocomplete:'new-password',maxLength:8192,hidden:true,'aria-label':imageTitle+' API Key'});
    keyAction.addEventListener('change',()=>{apiKey.hidden=keyAction.value!=='replace';if(apiKey.hidden)apiKey.value='';});
    const allowReferenceUpload=h('input',{type:'checkbox',checked:imageState.allowReferenceUpload,'aria-label':imageTitle+'允许上传参考图'});
    const sendResponseFormat=h('input',{type:'checkbox',checked:imageState.sendResponseFormat,'aria-label':imageTitle+'发送 response_format'});
    fields.image={enabled,endpoint,editsEndpoint,model,keyAction,apiKey,allowReferenceUpload,sendResponseFormat};
    for(const input of Object.values(fields.image))for(const event of ['input','change'])input.addEventListener(event,update);
    form.append(h('section.ai-provider',{'data-ai-role':'image'},h('h4',{},imageTitle),h('p.hint',{},'OpenAI-compatible Images；与主/辅助文字接口独立。'),
      h('label.check',{},enabled,'启用'),label('完整生成接口（/images/generations）',endpoint),label('完整编辑接口（/images/edits，使用参考图时需要）',editsEndpoint),
      label('图片模型名称',model),label('密钥',keyAction),apiKey,
      h('label.check',{},allowReferenceUpload,'允许上传选中的参考图'),h('label.check',{},sendResponseFormat,'发送 response_format=b64_json'),
      h('p.hint',{},'启用后，新生图请求使用已保存的图片配置。')));
    // Switching the directory retains the same controls and the single save payload.
    const providerNav=h('nav.ai-provider-nav',{'aria-label':'AI 服务目录'});
    function selectProvider(role){
      activeRole=role;
      for(const section of form.querySelectorAll('[data-ai-role]'))section.hidden=section.dataset.aiRole!==role;
      for(const button of providerNav.children)button.setAttribute('aria-pressed',String(button.dataset.providerRole===role));
    }
    providerNav.append(...[['main','DM 叙事主模型','冒险叙事与规则判断'],['helper','轻量辅助模型','辅助文本处理'],['image','地图图片服务','生成与编辑图片']].map(([role,title,hint])=>
      h('button.btn.sheet-entry',{type:'button','data-provider-role':role,onclick:()=>selectProvider(role)},h('strong',{},title),h('small',{},hint))));
    form.append(providerNav);selectProvider(activeRole);
    // The save bar applies to all providers, including hidden, edited sections.
    const actions=h('div.btn-row.sticky-actions.ai-save-actions',{},save,retry,readProbe,reload);editor.append(form,actions);
    function update(){
      if(disposed||generation!==drawGeneration)return;
      dirty=['main','helper'].some(role=>{
        const edited=value(role),saved=state[role];
        return edited.enabled!==saved.enabled||edited.provider!==saved.provider||edited.baseUrl!==saved.baseUrl
          ||edited.model!==saved.model||edited.endpointIsComplete!==!!saved.endpointIsComplete||edited.keyAction!=='keep';
      })||imageChanged();
      form.disabled=busy||!!pending||!verified;save.disabled=busy||!!pending||!verified;
      retry.hidden=!pending;retry.disabled=busy;reload.disabled=busy||!!pending;readProbe.hidden=!probeId;readProbe.disabled=busy;
      for(const {test,testHint,role} of tests){
        test.disabled=busy||!!pending||dirty||!verified;
        const reason=busy?'请求处理中…':pending?'上次请求结果未确认，请重试原请求。':!verified?'请重新读取最新配置后测试。'
          :dirty?'有未保存的修改，请先保存 AI 配置后测试。':!state[role].enabled?'此模型配置尚未启用；测试会检查已保存配置，不向供应商发送请求。':`测试已保存的模型 ${state[role].model||'（未设置）'}；发送一次请求。`;
        if(testHint.textContent!==reason)testHint.textContent=reason;test.title=reason;
      }
    }
    function imageChanged(){
      const edited=value('image');
      return edited.enabled!==imageState.enabled||edited.endpoint!==imageState.endpoint||edited.editsEndpoint!==imageState.editsEndpoint
        ||edited.model!==imageState.model||edited.allowReferenceUpload!==imageState.allowReferenceUpload
        ||edited.sendResponseFormat!==imageState.sendResponseFormat||edited.keyAction!=='keep';
    }
    function value(role){
      const f=fields[role];
      if(role==='image')return {enabled:f.enabled.checked,endpoint:f.endpoint.value.trim(),editsEndpoint:f.editsEndpoint.value.trim(),model:f.model.value.trim(),
        keyAction:f.keyAction.value,apiKey:f.apiKey.value,allowReferenceUpload:f.allowReferenceUpload.checked,sendResponseFormat:f.sendResponseFormat.checked};
      return {enabled:f.enabled.checked,provider:f.provider.value,baseUrl:f.baseUrl.value.trim(),model:f.model.value.trim(),keyAction:f.keyAction.value,apiKey:f.apiKey.value,endpointIsComplete:f.endpointMode.value==='complete'};
    }
    async function sendOriginal(){
      const original=pending,transport=api;if(!original||!transport||busy||disposed)return;
      busy=true;update();
      try{
        const result=await (original.kind==='save'?transport.save(original.body):transport.test(original.body));
        if(!current())return;
        pending=null;
        if(original.kind==='save'){
          state=result;verified=false;for(const f of Object.values(fields))f.apiKey.value='';
          try{
            const latest=await transport.read();if(!current())return;
            state=latest;verified=true;
            message.textContent=latest.version===result.version?'AI 配置已保存。':'原保存请求已确认，但配置随后已被更新；现显示服务端最新配置。';
          }catch{if(current())message.textContent='保存请求已确认，但最新配置读取失败。当前仅显示原回执；请重新读取后再编辑或测试。';}
          if(current()){busy=false;draw();}
        }else{probeId=result.requestId;showTest(result.role,result.message);}
      }catch(error){
        if(current()){
          if(error.unconfirmed===false)pending=null;
          if(original.kind==='test')showTest(JSON.parse(original.body).role,error.message);else message.textContent=error.message;
        }
      }
      finally{busy=false;if(current())update();}
    }
    async function saveSettings(){
      if(busy||pending||disposed||!verified)return;
      const payload={requestId:newUuid(),expectedVersion:state.version,main:value('main'),helper:value('helper'),...(imageChanged()?{image:value('image')}:{})};
      pending={kind:'save',body:JSON.stringify(payload)};await sendOriginal();
    }
    async function testModel(role){
      if(busy||pending||disposed||dirty||!verified)return;
      probeId=newUuid();pending={kind:'test',body:JSON.stringify({requestId:probeId,expectedVersion:state.version,role,confirmProviderUse:true})};await sendOriginal();
    }
    // The result belongs next to the button that started the test, not at the foot of the page.
    function showTest(role,text){for(const t of tests)t.testResult.textContent=t.role===role?text:'';}
    async function retryOriginal(){await sendOriginal();}
    async function readTest(){
      if(!probeId||busy||disposed)return;const transport=api;busy=true;update();
      try{const result=await transport.probe(probeId);if(current()){showTest(result.role,result.message);if(result.status!=='unknown'&&pending?.kind==='test')pending=null;}}
      catch(error){if(current())message.textContent=error.message;}
      finally{busy=false;if(current())update();}
    }
    async function reloadSettings(){
      if(busy||pending||disposed)return;
      if(dirty&&!await confirmDialog({title:'放弃表单改动并重新读取？',lines:['尚未保存的 API Key 和模型改动将丢弃。'],confirmText:'重新读取'}))return;
      if(disposed)return;const transport=api;busy=true;update();
      try{const value=await transport.read();if(current()){state=value;verified=true;busy=false;draw();message.textContent='已重新读取服务端配置。';}}
      catch(error){if(current())message.textContent=error.message;}
      finally{busy=false;if(current())update();}
    }
    update();
  }
}

export function renderAiPage(mount,ctx){
  const view=h('div.view',{},pageHead('AI 设置','保存后用于新请求；在途请求不变。'));
  mount.append(view);mount.addEventListener('dispose',()=>view.dispatchEvent(new Event('dispose')),{once:true});
  if(!ctx.account?.user.isAdmin){view.append(h('p.error-box',{},'只有管理员可以修改 AI 设置。'));return;}
  renderAiSettings(view,ctx);
}
