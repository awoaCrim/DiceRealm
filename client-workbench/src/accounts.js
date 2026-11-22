import {ApiError,bindRequestError,modelRequestQuery,validModelRequestPage,validModelRequest} from './api.js';

export const ACCOUNT_KEY='dicerealm.workbench.account.v1';
const tokenPattern=/^[0-9a-f]{64}$/i;
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validUser(value){
  return !!value&&typeof value.id==='string'&&value.id.length>0&&typeof value.username==='string'
    &&typeof value.isAdmin==='boolean'&&typeof value.disabled==='boolean';
}
export function normalizeAccount(value){
  if(!value||!tokenPattern.test(value.accessToken)||!validUser(value.user))throw new Error('登录记录不完整，请重新登录。');
  return {accessToken:value.accessToken,user:{id:value.user.id,username:value.user.username,isAdmin:value.user.isAdmin,disabled:value.user.disabled}};
}
export function loadAccount(storage){
  const value=storage.getItem(ACCOUNT_KEY);
  return value?normalizeAccount(JSON.parse(value)):null;
}
export function saveAccount(storage,value){const account=normalizeAccount(value);storage.setItem(ACCOUNT_KEY,JSON.stringify(account));return account;}
export function clearAccount(storage){storage.removeItem(ACCOUNT_KEY);}
export const selectedCampaignKey=userId=>'dicerealm.workbench.selected-campaign.'+userId;

// Account writes are not game commands and never share game pending receipts.
// Freeze the credential in this transport so a late view cannot act as a newly logged-in user.
export function createAccountApi({accessToken='',fetchImpl=fetch,timeoutMs=20000}={}){
  async function request(path,method='GET',payload){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await fetchImpl('/api/v1/accounts'+path,{method,
        headers:{...(accessToken?{Authorization:'Bearer '+accessToken}:{}),...(payload!==undefined?{'Content-Type':'application/json'}:{})},
        ...(payload!==undefined?{body:JSON.stringify(payload)}:{}),signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error'});
      const text=await response.text();
      if(text.length>2*1024*1024)throw new ApiError('账户响应过大，请重新读取。');
      let value;try{value=JSON.parse(text);}catch{throw new ApiError('账户响应不完整，请重新读取；不要重复创建。');}
      if(!response.ok)throw new ApiError(typeof value?.message==='string'?value.message:'账户请求失败。',response.status,value?.code||'account_error');
      const userResult=path==='/me'||path==='/users'||/^\/users\/[^/]+\/status$/.test(path);
      if(path==='/login')return normalizeAccount(value);
      if(path.startsWith('/model-requests')){
        if(!(path.startsWith('/model-requests?')?validModelRequestPage(value):validModelRequest(value)))throw new ApiError('请求日志响应不完整。');
        return value;
      }
      if(path==='/users'&&method==='GET'){
        if(!Array.isArray(value?.users)||!value.users.every(validUser))throw new ApiError('用户列表响应不完整。');
      }else if(userResult){if(!validUser(value))throw new ApiError('用户资料响应不完整。');}
      else if(path==='/campaigns'&&method==='GET'){
        if(!Array.isArray(value?.campaigns)||!value.campaigns.every(c=>c&&typeof c.id==='string'&&(c.unavailable===true?c.id.length>0:idPattern.test(c.id))&&typeof c.name==='string'&&typeof c.archived==='boolean'&&(c.unavailable===undefined||typeof c.unavailable==='boolean')))throw new ApiError('战役列表响应不完整。');
      }else if(path==='/campaigns'&&method==='POST'){
        if(!idPattern.test(value?.campaignId))throw new ApiError('创建响应不完整，请刷新战役列表，不要重复创建。');
      }else if(value?.ok!==true)throw new ApiError('账户操作响应不完整，请重新读取状态。');
      return value;
    }catch(error){
      if(error instanceof ApiError)throw bindRequestError(error,accessToken);
      throw bindRequestError(new ApiError('账户服务连接失败，结果尚未确认。请重新读取状态；不会自动重复提交。'),accessToken);
    }finally{clearTimeout(timer);}
  }
  return {
    login:(username,password)=>request('/login','POST',{username,password}),
    me:()=>request('/me'),logout:()=>request('/logout','POST'),
    campaigns:()=>request('/campaigns'),createCampaign:name=>request('/campaigns','POST',{name}),
    users:()=>request('/users'),createUser:(username,password)=>request('/users','POST',{username,password}),
    setDisabled:(id,disabled)=>request('/users/'+encodeURIComponent(id)+'/status','POST',{disabled}),
    resetPassword:(id,password)=>request('/users/'+encodeURIComponent(id)+'/password','POST',{password}),
    changePassword:(currentPassword,password)=>request('/password','POST',{currentPassword,password}),
    modelRequests:(params={})=>request('/model-requests?'+modelRequestQuery(params)),
    modelRequest:id=>request('/model-requests/'+encodeURIComponent(String(id)))
  };
}
