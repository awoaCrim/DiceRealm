import test from 'node:test';
import assert from 'node:assert/strict';
import {validAdventureSession,validAdventureProgress} from '../src/api.js';
import {progressLabel} from '../src/story-progress.js';

test('delegated parent is a valid non-completed progress and preserves the input identity',()=>{
  const battle='00000000-0000-0000-0000-000000000001';
  const parent={sessionId:'00000000-0000-0000-0000-000000000002',battleSessionId:battle,phase:'delegated',question:'',outcome:'',notice:'',actionText:'保护同伴',confirmation:null,replayed:false};
  assert.equal(validAdventureSession(parent),true);
  assert.notEqual(parent.sessionId,parent.battleSessionId);
  for(const invalid of [123,{},'not-a-session']) assert.equal(validAdventureSession({...parent,battleSessionId:invalid}),false);
  assert.equal(validAdventureSession({...parent,battleSessionId:undefined}),true);
  const run={id:parent.sessionId,actorId:'self',actorName:'同伴',status:'delegated',succeeded:false,steps:[{number:1,kind:'tool',status:'done',tool:'combat_delegate',waitKind:''}]};
  assert.equal(validAdventureProgress({runs:[run]}),true);
  assert.equal(validAdventureProgress({runs:[{...run,succeeded:true}]}),false);
  assert.match(progressLabel(run.steps[0]),/交接战斗主持/);
});

// Each return opens a fresh generation interval; the host reads the complete cumulative trace.
test('typed battle parents, blocked return and cumulative progress stay readable',()=>{
  const parent='00000000-0000-0000-0000-000000000002';
  const child={sessionId:'00000000-0000-0000-0000-000000000003',role:'combat',parentSessionId:parent,phase:'done',question:'',outcome:'本次输入已完成',notice:'',actionText:'交涉',confirmation:null,replayed:false};
  assert.equal(validAdventureSession(child),true);
  assert.equal(validAdventureSession({...child,parentSessionId:'invalid'}),false);
  assert.equal(validAdventureSession({...child,parentSessionId:child.sessionId}),false);
  assert.equal(validAdventureSession({...child,role:'exploration'}),false);
  assert.equal(validAdventureSession({...child,phase:'blocked',notice:'原委派凭证已失效'}),true);
  const steps=Array.from({length:66},(_,index)=>({number:index+1,kind:'tool',status:'done',tool:'combat_history_read',waitKind:''}));
  const run={id:parent,actorId:'self',actorName:'同伴',status:'completed',succeeded:true,steps};
  assert.equal(validAdventureProgress({runs:[run]}),true);
  steps[65].number=65; assert.equal(validAdventureProgress({runs:[run]}),false);
});
