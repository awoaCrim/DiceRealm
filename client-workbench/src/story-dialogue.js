import {h} from './dom.js';

// Only matched quotations get presentation. All input is appended as text nodes;
// even HTML-looking dialogue remains literal. Joining the ranges preserves the source.
export function dialogueParts(text){
  text=String(text??'');
  const result=[];let cursor=0;
  for(const match of text.matchAll(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\r\n]+"/g)){
    if(match.index>cursor)result.push({text:text.slice(cursor,match.index),dialogue:false});
    result.push({text:match[0],dialogue:true});cursor=match.index+match[0].length;
  }
  if(cursor<text.length)result.push({text:text.slice(cursor),dialogue:false});
  return result;
}
// Plain prose only: no HTML or arbitrary formatting commands, and no source rewrite.
export function proseText(text){
  return String(text??'').replace(/(?<![\\*])\*\*([^\s*](?:[^*\r\n]*?[^\s*])?)(?<!\\)\*\*(?!\*)/g,'$1');
}
// `lead` (e.g. a "仅 X 可见" tag) opens the first paragraph instead of standing as its own block.
export function storyParagraphs(text,{lead=null}={}){
  return proseText(text).split(/\n{2,}/).filter(Boolean).map((paragraph,index)=>
    h('p',{},index===0?lead:null,...dialogueParts(paragraph).map(part=>part.dialogue?h('span.story-dialogue',{},part.text):h('span',{},part.text))));
}
