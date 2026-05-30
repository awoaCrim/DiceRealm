import type { CharacterRecord } from '../types';

export function CharacterCard({ character }: { character: CharacterRecord | null }) {
  if (!character) return <section className="card"><h2>角色卡</h2><p className="muted">暂无角色。</p></section>;
  const sheet = character.sheet;
  return (
    <section className="card">
      <h2>{sheet.name}</h2>
      <p className="muted">{sheet.species} {sheet.className} · {sheet.level} 级</p>
      {sheet.background ? <p>背景：{sheet.background}</p> : null}
      {sheet.concept ? <p>{sheet.concept}</p> : null}
      <div className="stat-grid">
        <div className="stat-tile">
          <span className="muted">生命值</span>
          <strong>{sheet.hitPoints.current}/{sheet.hitPoints.max}</strong>
        </div>
        <div className="stat-tile">
          <span className="muted">护甲等级</span>
          <strong>{sheet.armorClass}</strong>
        </div>
      </div>
      <h3>技能</h3>
      <p>{sheet.skills.join(', ') || '无'}</p>
      <h3>装备</h3>
      <p>{sheet.equipment.join(', ') || '无'}</p>
      <h3>法术 / 能力</h3>
      <p>{sheet.spells.join(', ') || '无'}</p>
      <h3>语言与熟练</h3>
      <p>{[...(sheet.languages ?? []), ...(sheet.proficiencies ?? [])].join(', ') || '无'}</p>
      {(sheet.personality || sheet.ideal || sheet.bond || sheet.flaw) ? (
        <div className="subcard">
          <h3>扮演提示</h3>
          {sheet.personality ? <p>性格：{sheet.personality}</p> : null}
          {sheet.ideal ? <p>理想：{sheet.ideal}</p> : null}
          {sheet.bond ? <p>牵绊：{sheet.bond}</p> : null}
          {sheet.flaw ? <p>缺点：{sheet.flaw}</p> : null}
        </div>
      ) : null}
      {sheet.privateNotes ? <p className="muted">私密备注：{sheet.privateNotes}</p> : null}
    </section>
  );
}
