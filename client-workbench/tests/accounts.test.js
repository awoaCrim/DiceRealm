import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {installDom,settle} from './dom-shim.mjs';
import {createAccountApi,loadAccount,saveAccount,clearAccount} from '../src/accounts.js';
import {normalizeSession} from '../src/session.js';
import {createApi,isCurrentRequestError} from '../src/api.js';
import {createPendingStore} from '../src/pending.js';
import {renderLogin,renderUsers} from '../src/account-view.js';
import {renderCampaigns} from '../src/views.js';
installDom();
const id='11d9e63e-c68a-426f-8876-e6b094975902',user={id:'user-a',username:'甲',isAdmin:false,disabled:false};
const memory=()=>{const map=new Map();return {getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};};
const account={accessToken:'a'.repeat(64),user};
const button=(mount,label)=>mount.querySelectorAll('button').find(b=>b.textContent===label);

test('account transport freezes bearer, sends exact bodies and rejects malformed success',async()=>{
  const calls=[],api=createAccountApi({accessToken:account.accessToken,fetchImpl:async(url,options)=>{
    calls.push({url,options});return new Response(JSON.stringify(url.endsWith('/campaigns')?{campaignId:id}:user));
  }});
  await api.createCampaign('房间');await api.createUser('新用户','sample-password');
  assert.deepEqual(JSON.parse(calls[0].options.body),{name:'房间'});
  assert.deepEqual(JSON.parse(calls[1].options.body),{username:'新用户',password:'sample-password'});
  for(const {url,options} of calls){assert.ok(!url.includes(account.accessToken));assert.equal(options.headers.Authorization,'Bearer '+account.accessToken);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');}
  const broken=createAccountApi({fetchImpl:async()=>new Response('{}')});
  await assert.rejects(broken.campaigns(),/战役列表响应不完整/);
  await assert.rejects(broken.createCampaign('name'),/不要重复创建/);
  const denied=createAccountApi({fetchImpl:async()=>new Response(JSON.stringify({code:'forbidden',message:'无权访问'}),{status:403})});
  await assert.rejects(denied.users(),e=>e.status===403&&e.unconfirmed===false);
});

test('late authentication failures are bound to their original credential without exposing it on errors',async()=>{
  const fetchImpl=async()=>new Response(JSON.stringify({code:'unauthorized',message:'登录已失效'}),{status:401});
  for(const operation of [()=>createApi({fetchImpl}).request('snapshot',{campaignId:id,accessToken:account.accessToken}),()=>createAccountApi({fetchImpl,accessToken:account.accessToken}).me()]){
    await assert.rejects(operation(),error=>{
      assert.equal(isCurrentRequestError(error,account.accessToken),true);
      assert.equal(isCurrentRequestError(error,'different-login'),false);
      assert.equal(isCurrentRequestError(error,undefined),false);
      assert.ok(!JSON.stringify(error).includes(account.accessToken));
      return error.status===401;
    });
  }
});

test('stored account excludes extra password fields; logout clears only authentication',()=>{
  const storage=memory();storage.setItem('other-pending','unchanged');
  saveAccount(storage,{...account,password:'never-store',user:{...user,password:'never-store'}});
  assert.deepEqual(loadAccount(storage),account);
  clearAccount(storage);assert.equal(loadAccount(storage),null);assert.equal(storage.getItem('other-pending'),'unchanged');
});

test('pending scope survives account token rotation and separates users; legacy scope remains compatible',async()=>{
  const storage=memory(),base={baseUrl:'http://127.0.0.1:5180',campaignId:id,accessToken:account.accessToken};
  const first=await createPendingStore({storage,session:normalizeSession({...base,accountId:user.id},base.baseUrl),cryptoObj:webcrypto});
  first.capture('room-config',{requestId:id,password:'fixture-secret'});
  const again=await createPendingStore({storage,session:{...base,accessToken:'b'.repeat(64),accountId:user.id},cryptoObj:webcrypto});
  assert.equal(again.scope,first.scope);assert.equal(JSON.parse(again.read().payloadJson).requestId,id);
  const other=await createPendingStore({storage,session:{...base,accountId:'user-b'},cryptoObj:webcrypto});
  assert.equal(other.read(),null);assert.notEqual(other.scope,first.scope);
  const legacy=await createPendingStore({storage,session:base,cryptoObj:webcrypto});assert.notEqual(legacy.scope,first.scope);
});

test('login is single-flight, never offers a connection file, clears password after failure/dispose',async()=>{
  const mount=document.createElement('div'),calls=[];let reject;
  renderLogin(mount,{login:(...args)=>{calls.push(args);return new Promise((_,no)=>{reject=no;});}});
  const inputs=mount.querySelectorAll('input'),form=mount.querySelector('form');inputs[0].value=' admin ';inputs[1].value='fixture-password';
  const request=form.onsubmit({preventDefault(){}});await form.onsubmit({preventDefault(){}});
  assert.deepEqual(calls,[['admin','fixture-password']]);assert.equal(button(mount,'登录').disabled,true);
  reject(new Error('用户名或密码错误'));await request;
  assert.equal(inputs[1].value,'');assert.match(mount.textContent,/用户名或密码错误/);
  assert.equal(mount.querySelector('input[type="file"]'),null);
  inputs[1].value='sensitive';mount.dispatchEvent({type:'dispose'});assert.equal(inputs[1].value,'');
});

test('campaign entry reads server list and opens by id with no credential file or actor input',async()=>{
  const mount=document.createElement('div'),opened=[];
  renderCampaigns(mount,{account,accountApi:()=>({campaigns:async()=>({campaigns:[{id,name:'账户战役',archived:false}]})}),
    openCampaign:async value=>opened.push(value),report:e=>{throw e;},create:async()=>{}});
  await settle();assert.match(mount.textContent,/账户战役/);assert.equal(mount.querySelector('input[type="file"]'),null);
  assert.equal(mount.querySelector('input[type="password"]'),null);
  button(mount,'继续战役').dispatchEvent({type:'click'});await settle();assert.deepEqual(opened,[id]);
  mount.dispatchEvent({type:'dispose'});
});

test('unavailable campaign records are visible but cannot be opened; healthy rows remain usable',async()=>{
  const mount=document.createElement('div'),opened=[];
  const campaigns=[{id,name:'正常战役',archived:false,ownerUserId:user.id,ownerUsername:'甲'},
    {id:'bad-file',name:'无法读取的战役',archived:false,ownerUserId:null,ownerUsername:null,unavailable:true}];
  const transport=createAccountApi({fetchImpl:async()=>new Response(JSON.stringify({campaigns}))});
  assert.deepEqual((await transport.campaigns()).campaigns,campaigns);
  for(const unavailable of [false,'true']){
    const broken=createAccountApi({fetchImpl:async()=>new Response(JSON.stringify({campaigns:[{...campaigns[1],unavailable}]}))});
    await assert.rejects(broken.campaigns(),/战役列表响应不完整/);
  }
  renderCampaigns(mount,{account:{...account,user:{...user,isAdmin:true}},accountApi:()=>transport,
    openCampaign:async value=>opened.push(value),report:e=>{throw e;},create:async()=>{}});
  await settle();
  assert.match(mount.textContent,/1 场可访问战役；另有 1 条损坏或不支持/);
  assert.match(mount.textContent,/bad-file/);assert.match(mount.textContent,/归属无法确认/);
  assert.equal(mount.querySelectorAll('button').filter(b=>b.textContent==='继续战役').length,1);
  button(mount,'继续战役').dispatchEvent({type:'click'});await settle();assert.deepEqual(opened,[id]);
  const filter=mount.querySelector('select');filter.value='unavailable';filter.dispatchEvent({type:'change'});
  assert.equal(button(mount,'继续战役'),undefined);assert.match(mount.textContent,/暂不可进入/);
  mount.dispatchEvent({type:'dispose'});
});

test('a late campaign list cannot update a disposed user view',async()=>{
  const mount=document.createElement('div');let resolve;
  renderCampaigns(mount,{account,accountApi:()=>({campaigns:()=>new Promise(yes=>{resolve=yes;})}),report:e=>{throw e;},create:async()=>{}});
  mount.dispatchEvent({type:'dispose'});resolve({campaigns:[{id,name:'旧用户资料',archived:false}]});await settle();
  assert.ok(!mount.textContent.includes('旧用户资料'));
});

test('ordinary users never initialize user-management transport',async()=>{
  const mount=document.createElement('div');await renderUsers(mount,{account,accountApi:()=>{throw Error('not permitted');}});
  assert.match(mount.textContent,/只有管理员/);assert.equal(mount.querySelector('button'),null);
});
