// Engine prose on the player page (visual-v3 §5). The server writes a choice's price and note for the
// host and the AI DM: ability ids, how the engine settles it, English rule names. The player reads the
// price as the turn budget chips say it, and of the note the first sentence (what the choice does) and
// whom an area reaches. Display only: choices are still sent by their kind and target.
import {ruleText,abilityAbbreviations} from '../rule-labels.js';

const SHAPES={Sphere:'球形',Emanation:'散发',Cube:'立方',Cone:'锥形',Line:'线形',Cylinder:'圆柱'};
// The server marks every standard-combat choice with its ruleset; it says nothing about the choice.
const STANDARD_RANGE='标准2024模式 · 每格5尺';

export function playerText(text){
  return ruleText(abilityAbbreviations(String(text??'').replace(/(?<![A-Za-z])(STR|DEX|CON|INT|WIS|CHA)失败/g,'$1豁免失败')
    .replace(/(?<![A-Za-z])(?:Sphere|Emanation|Cube|Cone|Line|Cylinder)(?![A-Za-z])/g,m=>SHAPES[m])));
}

// Longest first: a phrase is replaced before any shorter phrase inside it.
const COSTS=[['先编辑分配；确认施放时才消耗1 Magic动作','分配好后施放：动作'],['1 Magic动作 + 原来源资源；还须本人施法确认','动作 + 法术位'],
  ['1 个 Attack 动作（逐次选择攻击目标）','动作'],['本次 Attack 动作剩余攻击 ×1','本次攻击动作的下一击'],
  ['1 个 Utilize 动作（本实现的明确拾取方式）','动作'],['1 个 Help 动作','动作'],['1 Magic动作','动作'],['1 个动作','动作'],
  ['1 附赠动作','附赠动作'],['1附赠动作','附赠动作'],['1 次反应','反应'],['1反应','反应'],['此来源无资源消耗','']];
export function costText(cost){
  let text=String(cost??'');
  for(const [from,to] of COSTS)text=text.split(from).join(to);
  // An equipment change that takes no adventure time ("0 秒") has no price to show.
  return playerText(text.split(/[;；]/).map(part=>part.trim()).filter(part=>part&&!/^0 ?秒$/.test(part)).join(' · '));
}

// The first sentence, and an area's reach ("目标：…" later in the note, allies marked 同伴).
export function noteText(note){
  const text=String(note??'').trim(),end=text.indexOf('。'),reach=/目标：([^。]+)。/.exec(text);
  return playerText((end<0?text:text.slice(0,end+1))+(reach&&end>=0&&reach.index>end?' 波及：'+reach[1]+'。':''));
}

// A choice's lines under its label: target, price, reach and what it does; a line the label already says is left out.
export function detailLines(label,details){
  const range=details?.range===STANDARD_RANGE?'':playerText(details?.range);
  return [playerText(details?.targetLabel),costText(details?.cost),range,noteText(details?.note)]
    .map(text=>String(text??'').trim()).filter(text=>text&&!String(label).includes(text));
}

// A roll card's description ends with the choice it carries out ("目标：X。消耗：Y。"); the sentence
// before it is the server's consent wording for the host.
export function rollWhy(description){
  const text=String(description??''),m=/目标：(.+?)。消耗：(.+?)。\s*$/.exec(text);
  return m?'目标：'+playerText(m[1])+' · 消耗：'+(costText(m[2])||'无'):playerText(text);
}
