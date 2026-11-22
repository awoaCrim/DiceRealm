// Splits a prompt into level-1 Markdown sections ("# 标题") for structured editing and joins them
// back byte-for-byte. Text before the first heading is a section with title null.
const headingStarts=value=>[...value.matchAll(/^# /gm)].map(match=>match.index);
// The heading line's title: everything after "# ", without the CR of a CRLF line break.
const headingTitle=line=>{
  const end=line.indexOf('\n'),text=end<0?line:line.slice(0,end);
  return text.endsWith('\r')?text.slice(2,-1):text.slice(2);
};
export function splitPrompt(text){
  const value=String(text??'').replace(/\r\n/g,'\n'),sections=[];
  const starts=headingStarts(value);
  if(!starts.length||starts[0]>0)sections.push({title:null,body:value.slice(0,starts[0]??value.length),hasBreak:false});
  starts.forEach((start,i)=>{
    const chunk=value.slice(start,starts[i+1]??value.length),end=chunk.indexOf('\n');
    sections.push(end<0?{title:chunk.slice(2),body:'',hasBreak:false}:{title:chunk.slice(2,end),body:chunk.slice(end+1),hasBreak:true});
  });
  return sections;
}
// The same level-1 headings as exact consecutive slices of the original text: the concatenation of
// the returned texts is the input, unchanged. Previews and the request log use this to show the real
// bytes (heading line and line breaks included) instead of a normalized rewrite.
export function splitPromptRaw(text){
  const value=String(text??''),starts=headingStarts(value),blocks=[];
  if(!starts.length||starts[0]>0)blocks.push({title:null,text:value.slice(0,starts[0]??value.length)});
  starts.forEach((start,i)=>{
    const slice=value.slice(start,starts[i+1]??value.length);
    blocks.push({title:headingTitle(slice),text:slice});
  });
  return blocks;
}
export function joinPrompt(sections){
  let text='';
  for(const s of sections){
    // An edited body may lose its final newline; a heading must still start its own line.
    if(s.title!==null&&text&&!text.endsWith('\n'))text+='\n';
    text+=s.title===null?s.body:'# '+s.title+(s.hasBreak||s.body?'\n':'')+s.body;
  }
  return text;
}
