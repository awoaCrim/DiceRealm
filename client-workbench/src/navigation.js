// The DM workbench has one page per job. Campaign pages need a connected campaign; the
// request log and AI settings are account pages (admin) that work without one.
// Groups name the kind of work, not who may open the page: every content page is host-gated
// too, so a "host" label would separate nothing. Reading stays apart from upkeep.
export const sections = [
  {id:'story',label:'剧情',group:'session'},
  {id:'world',label:'世界记录',group:'session'},
  {id:'room',label:'邀请玩家',host:true,group:'campaign'},
  {id:'saves',label:'存档与重开',host:true,group:'campaign'},
  {id:'campaign',label:'剧本',host:true,group:'content'},
  {id:'maps',label:'地图图册',host:true,group:'content'},
  {id:'prompts',label:'提示词',host:true,group:'content'}
];

export const adminPages = [
  {id:'requests',label:'请求日志'},
  {id:'ai',label:'AI 设置'}
];

const pages = {
  story:{section:'story',label:'剧情',group:'session',view:'story'},
  world:{section:'world',label:'世界记录',group:'session',view:'world'},
  room:{section:'room',label:'邀请玩家',group:'campaign',view:'room',host:true},
  saves:{section:'saves',label:'存档与重开',group:'campaign',view:'saves',host:true},
  campaign:{section:'campaign',label:'剧本',group:'content',view:'campaign',host:true},
  maps:{section:'maps',label:'地图图册',group:'content',view:'maps',host:true},
  prompts:{section:'prompts',label:'提示词',group:'content',view:'prompts',host:true}
};

// Bookmarks from the old workbench land on the page that now owns the same job.
const aliases = {
  live:'story',adventure:'story','adventure/requests':'story','live/rulings':'story',rulings:'story',party:'room',
  journal:'story','journal/system':'story',prepare:'campaign','prepare/settings':'campaign','content-settings':'campaign',workspace:'campaign',
  content:'campaign',prompt:'prompts','prepare/maps':'maps',atlas:'maps',system:'story',resources:'story'
};

// A host opening a room that has no adventure yet starts at its setup, not an empty story.
export function defaultRoute(snapshot){return snapshot?.party?.isHost&&snapshot.content?.initialSetup===true?'campaign':'story';}

export function resolveRoute(hash,{snapshot}={}){
  const requested=String(hash||'').replace(/^#\/?/,'').replace(/^\/+|\/+$/g,'');
  let path=aliases[requested]||requested;
  if(!Object.hasOwn(pages,path))path=defaultRoute();
  return {path,...pages[path],denied:!!pages[path].host&&!snapshot?.party?.isHost};
}

export function primaryNavigation(snapshot){
  return sections.filter(section=>!section.host||snapshot?.party?.isHost);
}

// Four groups by kind of work; a group with nothing visible for this seat is not rendered.
// Account pages stay available to an administrator even before a campaign has been opened.
export function navigationGroups(snapshot,{admin=false}={}){
  const visible=snapshot?primaryNavigation(snapshot):[];
  return [
    {id:'session',numeral:'壹',label:'本场',items:visible.filter(s=>s.group==='session')},
    {id:'campaign',numeral:'贰',label:'战役',items:visible.filter(s=>s.group==='campaign')},
    {id:'content',numeral:'叁',label:'内容',items:visible.filter(s=>s.group==='content')},
    {id:'admin',numeral:'肆',label:'管理',items:admin?adminPages:[]}
  ].filter(group=>group.items.length);
}
