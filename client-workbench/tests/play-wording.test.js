// Engine prose on the player page in the player's words (src/play/wording.js, actionLabel).
import test from 'node:test';
import assert from 'node:assert/strict';
import {costText,noteText,rollWhy,detailLines} from '../src/play/wording.js';
import {actionLabel} from '../src/rule-labels.js';

test('engine prices read as the turn budget says them', ()=>{
  assert.equal(costText('1 Magic动作; 此来源无资源消耗'),'动作');
  assert.equal(costText('先编辑分配；确认施放时才消耗1 Magic动作; Spell Slots (1st) ×1'),'分配好后施放：动作 · 法术位（一环） ×1');
  assert.equal(costText('1 个 Attack 动作（逐次选择攻击目标）'),'动作');
  assert.equal(costText('1 个 Help 动作；DC10 Wisdom (Medicine)'),'动作 · DC10 感知 (医药)');
  assert.equal(costText('1 附赠动作 + Second Wind ×1'),'附赠动作 + 回气 ×1');
  assert.equal(costText('15 尺移动'),'15 尺移动');
  assert.equal(costText('0 秒'),'');
});

test('a note keeps what the choice does and whom an area reaches, allies marked', ()=>{
  const note='60尺内中心(3,3)，5尺Sphere；DEX失败受Acid伤害，成功无伤害。含中心与施法者，DEX半/四分之三掩护+2/+5，有效Dodge优势。'+
    '本实现格心范围含友伤，完整掩护阻挡；目标：堤道守卫、Bram（同伴）。伤害骰同次一次，各目标分别豁免。';
  assert.equal(noteText(note),'60尺内中心(3,3)，5尺球形；敏捷豁免失败受强酸伤害，成功无伤害。 波及：堤道守卫、Bram（同伴）。');
  assert.equal(noteText('专注最多1分钟；每次针对自己的攻击掷骰减1d4。替换原专注。须能发声。'),'专注最多1分钟；每次针对自己的攻击掷骰减1d4。');
});

test('a cast choice shows its price and effect, not the ruleset marker or the engine limits', ()=>{
  const label=actionLabel('Blade Ward / Arden（class:wizard）');
  assert.equal(label,'剑刃防护 / Arden（法师）');
  assert.deepEqual(detailLines(label,{targetLabel:'Arden',cost:'1 Magic动作; 此来源无资源消耗',range:'标准2024模式 · 每格5尺',
    note:'专注最多1分钟；每次针对自己的攻击掷骰减1d4。替换原专注。'}),['动作','专注最多1分钟；每次针对自己的攻击掷骰减1d4。']);
  // In a reaction "Shield" is the spell, not the armour; the engine's bilingual actions keep their Chinese.
  assert.equal(actionLabel('Shield / Arden（class:wizard）'),'护盾术 / Arden（法师）');
  assert.equal(actionLabel('Dodge / 闪避'),'闪避');
  assert.equal(actionLabel('Greatsword / 弯刀河匪'),'巨剑 / 弯刀河匪');
  assert.equal(actionLabel('维持专注 / CON豁免'),'维持专注 / 体质豁免');
  assert.equal(actionLabel('放弃Shield反应'),'放弃护盾术反应');
  // An equipment change names its slot and weapon in the label; the same line in English is not repeated.
  const equip=actionLabel('近战主手 → Greatsword');
  assert.deepEqual(detailLines(equip,{targetLabel:'近战主手 → Greatsword',cost:'0 秒',range:'本人装备槽',note:'只修改指定槽位/组合/握持，不自动攻击。'}),
    ['本人装备槽','只修改指定槽位/组合/握持，不自动攻击。']);
});

test('a roll card says its target and price; other descriptions read in Chinese rule names', ()=>{
  assert.equal(rollWhy('本人确认候选所列的来源、目标、成分和资源后施放；治疗骰和后续效果由服务端结算。 目标：中心(3,3)。消耗：1 Magic动作; 此来源无资源消耗。'),
    '目标：中心(3,3) · 消耗：动作');
  assert.equal(rollWhy('本人确认后进行受伤的CON专注豁免。'),'本人确认后进行受伤的体质专注豁免。');
});
