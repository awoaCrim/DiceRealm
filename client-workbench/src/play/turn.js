// The player's own turn: which action is shown, what may be sent now, and when the client may
// continue on its own. Pure functions over the authoritative snapshot and the player's action board;
// the server decides every outcome. Ported from the Unity client (AdventureProtocol and
// PlayerInputPresentation) so both clients keep the same consent rules.

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSessionId=id=>typeof id==='string'&&UUID.test(id);
const terminal=new Set(['done','stopped','failed','unconfirmed']);
export const isTerminal=phase=>terminal.has(phase);
export const blocksInput=phase=>!isTerminal(phase)&&phase!=='delegated';

// Typed text is sent as one line; the server sees what the player wrote, trimmed.
export const normalizeText=text=>String(text??'').replace(/[\n\r\t]/g,' ').trim();

export const ownReview=s=>(s?.party?.members||[]).find(m=>m&&m.id===s.party.selfActorId)?.review||null;
// Lifecycle is the server's per-viewer projection, never an HP guess. Older servers omit it.
export const lifecycleAllowsActions=s=>s?.lifecycle==null||!!s.lifecycle.canAct&&s.lifecycle.status!=='game_over';
export const canAct=s=>lifecycleAllowsActions(s)&&(!ownReview(s)||ownReview(s).status==='approved');

export function reviewNotice(s){
  const review=ownReview(s);
  if(!review||review.status==='approved')return '';
  if(review.status==='returned')return '角色审核已退回：'+(review.reason||'')+'\n批准前不能执行冒险行动。';
  return (review.revision>1?'角色资料已重新提交（第 '+review.revision+' 次）':'角色资料已提交')+'，等待 DM 审核批准。批准后即可直接输入行动。';
}
// Why nothing can be started now, or '' when the seat may act.
export function lifecycleNotice(s){
  if(!lifecycleAllowsActions(s))return s.lifecycle.status==='game_over'?'游戏结束，全体玩家已死亡。等待 DM 读档或重开。'
    :(s.character?.conditions||[]).includes('Dead')?'你的角色已死亡，无法继续行动；仍可阅读队友的冒险。'
    :s.lifecycle.message||(s.archived?'战役已归档，可继续阅读记录。':'当前不能发起行动，可继续阅读记录。');
  return reviewNotice(s);
}

export const openingNeeded=s=>s?.opening?.needed===true;

// A battle may hand the player's input to its own combat action; follow it only when unambiguous.
export function selectBattleInput(selected,active=[]){
  if(selected&&selected.phase!=='delegated'&&!isTerminal(selected.phase))return selected;
  const candidates=active.filter(s=>blocksInput(s.phase));
  if(candidates.length!==1||!candidates[0].battleSessionId)return selected;
  const battle=candidates[0].battleSessionId;
  if(selected)return selected.battleSessionId===battle?candidates[0]:selected;
  return active.every(s=>s.battleSessionId===battle)?candidates[0]:null;
}
export const shouldFollowBattleParent=(selected,parent)=>selected?.role==='combat'&&isTerminal(selected.phase)&&isSessionId(selected.parentSessionId)
  &&parent?.sessionId===selected.parentSessionId&&parent.role==='exploration'
  &&(parent.phase!=='delegated'||parent.battleSessionId!==selected.battleSessionId);
// After a finished battle action, the exploration action it belonged to is the one to show,
// unless another combat action of the same battle still waits for the player.
export const needsBattleParent=(selected,active=[])=>selected?.role==='combat'&&isTerminal(selected.phase)&&isSessionId(selected.parentSessionId)
  &&!active.some(s=>s.role==='combat'&&s.battleSessionId===selected.battleSessionId&&blocksInput(s.phase));

export function matchesConfirmation(session,snapshot,kind,waitId){
  if(session?.phase!=='needsConfirmation'||!session.confirmation||!waitId)return false;
  const wait=session.confirmation;
  if(kind==='roll'&&wait.kind==='ruling'&&snapshot?.pendingRoll?.id===waitId)
    // A DM-requested roll links to this ruling only through an exact public receipt.
    return (snapshot.pendingRulings||[]).some(r=>r?.id===wait.waitId&&r.status==='awaiting_roll')
      &&(snapshot.events||[]).some(e=>e?.resolution?.rulingId===wait.waitId&&e.resolution.rollId===waitId);
  if(wait.kind!==kind||wait.waitId!==waitId)return false;
  return kind==='roll'?snapshot?.pendingRoll?.id===waitId:kind==='intent'&&snapshot?.pendingIntent?.id===waitId;
}
// Whether the open roll request is this player's to consent to.
export function canConfirmRoll(session,snapshot){
  const id=snapshot?.pendingRoll?.id;
  if(!lifecycleAllowsActions(snapshot)||!id)return false;
  if(matchesConfirmation(session,snapshot,'roll',id))return true;
  // A group wait of the persistent battle is still confirmed only by its own ID. A seat whose own
  // last action has ended (a teammate started the fight) confirms it like a seat with none.
  const battle=snapshot.pendingRoll.battleSessionId;
  if(isSessionId(battle)&&(!session||isTerminal(session.phase)||session.battleSessionId===battle))return true;
  // Otherwise only a roll of a server choice this page proposed itself: a combat action, or the
  // recovery offered after a rest (a hit die).
  const actor=snapshot.party?.selfActorId??'player';
  return (snapshot.events||[]).some(e=>e?.kind==='roll.request'&&e.actorId===actor&&e.resolution?.rollId===id&&e.resolution.status==='awaiting_roll'
    &&!e.resolution.intentId&&/^(combat|rest)\./.test(String(e.origin?.requestedKind||'')));
}
export function canContinue(session,snapshot){
  if(!session||!snapshot||!lifecycleAllowsActions(snapshot))return false;
  if(session.phase==='ready')return true;
  if(session.phase!=='needsConfirmation'||!session.confirmation)return false;
  const wait=session.confirmation;
  // Continuing only checks the original result; it is never consent to a new wait.
  if(wait.kind==='roll')return snapshot.pendingRoll?.id!==wait.waitId;
  if(wait.kind==='intent')return snapshot.pendingIntent?.id!==wait.waitId;
  const ruling=(snapshot.pendingRulings||[]).find(r=>r?.id===wait.waitId);
  return wait.kind==='ruling'&&ruling?.status!=='pending'&&ruling?.status!=='awaiting_roll';
}
function continuationEvidence(session,snapshot){
  const wait=session?.confirmation;if(!wait)return null;
  const found=(snapshot?.events||[]).filter(e=>{
    const result=e?.resolution;if(!result)return false;
    if(wait.kind==='roll')return result.rollId===wait.waitId&&(result.check!=null||result.status==='resolved'||result.status==='cancelled');
    return wait.kind==='intent'&&result.intentId===wait.waitId&&['resolved','cancelled','awaiting_roll','needs_adjudication'].includes(result.status);
  }).sort((a,b)=>a.sequence-b.sequence);
  return found[found.length-1]||null;
}
// A vanished wait is not proof of completion: continue on its own only with an exact saved result.
export function canAutoContinue(session,snapshot){
  if(session?.phase!=='needsConfirmation'||!canContinue(session,snapshot))return false;
  const wait=session.confirmation;
  if(wait.kind==='ruling')return (snapshot.pendingRulings||[]).some(r=>r?.id===wait.waitId&&r.status==='resolved');
  return continuationEvidence(session,snapshot)!=null;
}
// One automatic attempt per exact saved completion, not per snapshot change.
export function autoContinueKey(session,snapshot){
  if(!session)return '';
  const key=session.sessionId+'/'+session.confirmation?.kind+'/'+session.confirmation?.waitId;
  return session.confirmation?.kind==='intent'?key+'/'+(continuationEvidence(session,snapshot)?.sequence??0):key;
}

export const canStop=session=>!!session&&!['done','stopped','failed','unconfirmed','stopping'].includes(session.phase);

// turn = {snapshot, mode:'unknown'|'business'|'legacy', ready, session, active}
export function canSend({snapshot,mode,ready,session,active=[]}){
  if(mode!=='business'||!ready||!canAct(snapshot))return false;
  if(active.some(s=>s.sessionId!==session?.sessionId&&blocksInput(s.phase)))return false;
  if(canConfirmRoll(session,snapshot)||session?.phase==='needsAnswer')return true;
  return (!session||!blocksInput(session.phase))&&!snapshot?.pendingRoll&&!snapshot?.pendingIntent;
}
export function canStartOpening({snapshot,mode,ready,session,active=[]}){
  return openingNeeded(snapshot)&&mode==='business'&&ready&&canAct(snapshot)&&snapshot.archived!==true
    &&!snapshot.pendingRoll&&!snapshot.pendingIntent&&(!session||isTerminal(session.phase))
    &&!active.some(s=>blocksInput(s.phase));
}

// The one request the composer would send for this text, or an Error saying why not.
// Returns {endpoint,payload} without requestId/version; the caller freezes those when it captures.
export function composerRequest(turn,text){
  if(openingNeeded(turn.snapshot))return canStartOpening(turn)?{endpoint:'adventure-opening',payload:{}}:new Error('入场开场尚未就绪，请稍候或同步后再试。');
  if(!canSend(turn))return new Error('请先读取、回答或处理当前行动；结果未确认时不能补发。');
  const normalized=normalizeText(text);
  if(!normalized)return new Error('请先写下行动或回答。');
  const {snapshot,session}=turn;
  if(canConfirmRoll(session,snapshot)){
    if(normalized!=='投掷'&&normalized!=='取消')return new Error('当前等待投掷同意：输入“投掷”或“取消”；其他行动请在处理后发送。');
    const roll=snapshot.pendingRoll;
    if(normalized==='投掷'&&(!roll.available||roll.version!==snapshot.version))return new Error(roll.reason||'投掷条件已变化，请读取当前状态或明确取消。');
    return {endpoint:'rolls/respond',payload:{rollId:roll.id,decision:normalized==='投掷'?'roll':'cancel'}};
  }
  if(session?.phase==='unconfirmed'&&normalized===normalizeText(session.actionText))
    return new Error('原行动的结果尚未确认，不能按相同原文补发；可以同步读取，或描述另一项新行动。');
  return session?.phase==='needsAnswer'
    ?{endpoint:'adventure-continue',payload:{sessionId:session.sessionId,text:normalized}}
    :{endpoint:'adventure-act',payload:{text:normalized}};
}
