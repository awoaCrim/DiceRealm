// Minimal DOM stand-in for render tests: no dependency, no fake assertions.
// It implements only what src/dom.js and the workbench views touch, so a test can
// exercise the real render functions in Node without installing jsdom.
class Element {
  constructor(tag){
    this.nodeType=1;this.tagName=String(tag).toUpperCase();this.children=[];this.attrs={};this.dataset={};this.listeners={};this._text='';
    this.hidden=false;this.disabled=false;this.checked=false;this.value='';this.open=false;this.id='';
    this.classList={_s:new Set(),add(...c){c.forEach(x=>x&&this._s.add(x));},remove(...c){c.forEach(x=>this._s.delete(x));},
      contains(c){return this._s.has(c);},toggle(c,on){if(on===undefined){this._s.has(c)?this._s.delete(c):this._s.add(c);}else if(on)this._s.add(c);else this._s.delete(c);}};
  }
  get className(){return [...this.classList._s].join(' ');}
  set className(v){this.classList._s=new Set(String(v).trim().split(/\s+/).filter(Boolean));}
  appendChild(node){
    if(node?.__fragment){node.children.forEach(c=>this.appendChild(c));return node;}
    if(node?.__text){this._text+=node.textContent;return node;}
    this.children.push(node);node.parentNode=this;
    if(this.tagName==='SELECT'&&node.tagName==='OPTION'&&!this.value)this.value=node.value;
    return node;
  }
  append(...nodes){nodes.forEach(n=>{if(n==null||n===false)return;this.appendChild(n);});}
  replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes.map(node=>node!==null&&typeof node==='object'?node:{__text:true,textContent:String(node)}));}
  removeChild(node){this.children=this.children.filter(c=>c!==node);return node;}
  remove(){this.parentNode?.removeChild(this);}
  contains(node){return !!node&&(node===this||this.children.some(child=>child===node||child.contains?.(node)));}
  setAttribute(k,v){
    if(k==='class')this.className=v;else if(k==='id')this.id=String(v);
    else if(k==='value')this.value=String(v);else if(k==='checked')this.checked=true;
    else if(k==='hidden'){this.hidden=true;this.attrs[k]=String(v);}
    else if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(m,c)=>c.toUpperCase())]=(v===true?'':String(v));
    else this.attrs[k]=(v===true?'':String(v));
  }
  getAttribute(k){return k==='id'?this.id:(this.attrs[k]??null);}
  hasAttribute(k){return k==='id'?this.id!=='':Object.prototype.hasOwnProperty.call(this.attrs,k);}
  addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}
  removeEventListener(type,fn){this.listeners[type]=(this.listeners[type]||[]).filter(f=>f!==fn);}
  dispatchEvent(event){const e=typeof event==='string'?{type:event}:event;[...(this.listeners[e.type]||[])].forEach(fn=>fn(e));}
  showModal(){}
  focus(){if(globalThis.document)globalThis.document.activeElement=this;}
  close(){this.dispatchEvent({type:'close'});}
  get textContent(){return this._text+(this.children.length?this.children.map(c=>c.textContent||'').join(''):'');}
  set textContent(v){this._text=String(v);this.children=[];}
  get options(){return this.tagName==='SELECT'?this.children.filter(c=>c.tagName==='OPTION'):undefined;}
  querySelector(sel){return this.querySelectorAll(sel)[0]||null;}
  querySelectorAll(sel){const out=[];const walk=node=>{for(const child of node.children||[]){if(!child.tagName)continue;if(matches(child,sel))out.push(child);walk(child);}};walk(this);return out;}
}
function matches(el,sel){
  const attr=sel.match(/\[([^\]]+)\]/),base=sel.replace(/\[[^\]]+\]/g,''),parts=base.split('.').filter(Boolean);
  let tag=null,classes=parts;
  if(!base.startsWith('.')){tag=parts.shift();classes=parts;}
  if(tag&&el.tagName!==tag.toUpperCase())return false;
  if(classes.some(c=>!el.classList.contains(c)))return false;
  if(attr){
    const raw=attr[1],name=raw.replace(/=.*$/,''),want=raw.includes('=')?raw.split('=')[1].replace(/^["']|["']$/g,''):null;
    const have=name.startsWith('data-')?el.dataset[name.slice(5).replace(/-([a-z])/g,(m,c)=>c.toUpperCase())]:el.attrs[name];
    if(have===undefined||have===null)return false;
    if(want!==null&&String(have)!==want)return false;
  }
  return true;
}
export function installDom(){
  const document={defaultView:Object.assign(new EventTarget(),{innerWidth:1440,innerHeight:960}),createElement:tag=>{const el=new Element(tag);el.ownerDocument=document;return el;},createTextNode:text=>({nodeType:3,__text:true,textContent:String(text)}),
    createDocumentFragment:()=>{const fragment=new Element('#fragment');fragment.__fragment=true;return fragment;}};
  document.createElementNS=(namespace,tag)=>{const el=document.createElement(tag);el.namespaceURI=namespace;return el;};
  document.body=new Element('body');
  document.querySelector=selector=>document.body.querySelector(selector);
  document.querySelectorAll=selector=>document.body.querySelectorAll(selector);
  globalThis.document=document;
  globalThis.window=document.defaultView;
  return document;
}
export const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
export const settle=async(times=3)=>{for(let i=0;i<times;i++)await tick();};
