import test from 'node:test';
import assert from 'node:assert/strict';
import {draftKey,readDraft,writeDraft,clearDraft,clearCampaignDrafts,draftCount} from '../src/drafts.js';

test('drafts keep unsent text per campaign and ruling and clear on request',()=>{
  clearCampaignDrafts('c1');clearCampaignDrafts('c2');
  const key=draftKey('c1','r1');
  assert.equal(readDraft(key),'');
  writeDraft(key,'尚未发送的理由');
  assert.equal(readDraft(key),'尚未发送的理由');
  assert.equal(readDraft(draftKey('c2','r1')),'','另一场战役读不到这份草稿');
  writeDraft(key,'   ');
  assert.equal(readDraft(key),'','纯空白等于删掉草稿');
  writeDraft(key,'保留');
  clearDraft(key);
  assert.equal(readDraft(key),'');
});

test('clearing one campaign leaves other campaigns alone',()=>{
  clearCampaignDrafts('c1');clearCampaignDrafts('c2');
  writeDraft(draftKey('c1','r1'),'a');writeDraft(draftKey('c1','r2'),'b');writeDraft(draftKey('c2','r1'),'c');
  assert.ok(draftCount()>=3);
  clearCampaignDrafts('c1');
  assert.equal(readDraft(draftKey('c1','r1')),'');
  assert.equal(readDraft(draftKey('c1','r2')),'');
  assert.equal(readDraft(draftKey('c2','r1')),'c');
  clearCampaignDrafts('c2');
});
