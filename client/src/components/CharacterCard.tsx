import type { CharacterRecord, CharacterResources, PlayerRulesSummary } from '../types';

type CharacterCardProps = {
  character: CharacterRecord | null;
  resources?: CharacterResources;
  rules?: PlayerRulesSummary;
};

const abilityLabels = {
  str: '力量',
  dex: '敏捷',
  con: '体质',
  int: '智力',
  wis: '感知',
  cha: '魅力'
} as const;

function hpPercent(current: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round(current / max * 100)));
}

function hpColor(current: number, max: number): string {
  if (current <= 0) return '#de6f62';
  return current > max / 2 ? '#79bd74' : '#dfa34b';
}

function spellSlotLevelLabel(level: string): string {
  const match = /^level(\d+)$/.exec(level);
  return match ? `${match[1]} 环` : level;
}

export function CharacterCard({
  character,
  resources,
  rules
}: CharacterCardProps) {
  if (!character) return <section className="card"><h2>角色卡</h2><p className="muted">暂无角色。</p></section>;

  const sheet = character.sheet;
  const speciesLine = `${sheet.species || '未选种族'}${sheet.subSpecies ? `（${sheet.subSpecies}）` : ''}`;
  const classLine = `${sheet.className || '未选职业'}${sheet.classDetail ? `（${sheet.classDetail}）` : ''}`;
  const hitPoints = resources?.hitPoints ?? sheet.hitPoints;
  const temporaryHitPoints = resources?.hitPoints.temp ?? 0;
  const spellSlotEntries = resources
    ? Object.entries(resources.spellSlots).filter(([, slots]) => slots.total > 0 || slots.used > 0)
    : [];

  return (
    <section className="card">
      <div className="section-heading-row">
        <h2>{sheet.name}</h2>
      </div>
      <p className="muted">{speciesLine} {classLine} · {sheet.level} 级</p>
      <div className="character-detail-body">
        <section className="subcard detail-panel">
          <h3>基础信息</h3>
          {sheet.background ? <p>背景：{sheet.background}</p> : null}
          {sheet.concept ? <p>概念：{sheet.concept}</p> : null}
          <p>熟练加值：+{sheet.proficiencyBonus}</p>
        </section>

        <section className="subcard detail-panel">
          <h3>核心资源</h3>
          <div className="stat-grid">
            <div className="stat-tile">
              <span className="muted">HP</span>
              <strong>{hitPoints.current}/{hitPoints.max}</strong>
              {temporaryHitPoints > 0 ? <small>临时 {temporaryHitPoints}</small> : null}
            </div>
            <div className="stat-tile">
              <span className="muted">AC</span>
              <strong>{sheet.armorClass}</strong>
            </div>
            <div className="stat-tile">
              <span className="muted">熟练</span>
              <strong>+{sheet.proficiencyBonus}</strong>
            </div>
          </div>
          <div className="hp-bar-bg">
            <div className="hp-bar-fill" style={{
              width: `${hpPercent(hitPoints.current, hitPoints.max)}%`,
              background: hpColor(hitPoints.current, hitPoints.max)
            }} />
          </div>
          {resources?.hitDice.total ? <p>生命骰：{resources.hitDice.remaining} / {resources.hitDice.total} ({resources.hitDice.die})</p> : null}
          {spellSlotEntries.length > 0 ? (
            <div>
              <strong>法术位</strong>
              {spellSlotEntries.map(([level, slots]) => (
                <p key={level}>{spellSlotLevelLabel(level)}：{slots.total - slots.used} / {slots.total}</p>
              ))}
            </div>
          ) : null}
          {resources ? <p>货币：{resources.currency.gp} gp · {resources.currency.sp} sp · {resources.currency.cp} cp</p> : null}
          {resources?.conditions.length ? <p>状态：{resources.conditions.join('、')}</p> : null}
        </section>

        <section className="subcard detail-panel detail-wide">
          <h3>属性</h3>
          <div className="ability-grid">
            {Object.entries(abilityLabels).map(([key, label]) => (
              <span key={key}>{label} {sheet.abilityScores[key as keyof typeof abilityLabels]}</span>
            ))}
          </div>
        </section>

        {rules?.savingThrows.length ? (
          <section className="subcard detail-panel">
            <h3>豁免</h3>
            <div className="rules-stat-grid">
              {rules.savingThrows.map((save) => (
                <div className={save.proficient ? 'is-proficient' : ''} key={save.key}>
                  <strong>{save.label}</strong>
                  <span>{save.modifier}</span>
                  <small>{save.proficient ? '熟练' : '未熟练'}</small>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {rules?.actionEconomy.length ? (
          <section className="subcard detail-panel">
            <h3>行动资源</h3>
            <div className="action-economy-grid">
              {rules.actionEconomy.map((item) => (
                <div key={item.title}>
                  <strong>{item.title}</strong>
                  <span>{item.value}</span>
                  <small>{item.detail}</small>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {rules?.skills.length ? (
          <section className="subcard detail-panel detail-wide">
            <h3>技能检定</h3>
            <div className="rules-stat-grid skills-grid">
              {rules.skills.map((skill) => (
                <div className={skill.proficient ? 'is-proficient' : ''} key={skill.key}>
                  <strong>{skill.label}</strong>
                  <span>{skill.modifier}</span>
                  <small>{skill.ability}{skill.proficient ? ' · 熟练' : ''}</small>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="subcard detail-panel detail-wide">
          <h3>语言与熟练</h3>
          <p>语言：{(sheet.languages ?? []).join('、') || '无'}</p>
          <p>熟练：{(sheet.proficiencies ?? []).join('、') || '无'}</p>
        </section>

        {rules?.availableActions.length ? (
          <section className="subcard detail-panel detail-wide available-actions-card">
            <h3>可用行动</h3>
            <div className="available-action-list">
              {rules.availableActions.map((item) => (
                <article className="available-action-item" key={item.id}>
                  <header>
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.subtitle}</p>
                    </div>
                    <span className="action-timing">{item.timing}</span>
                  </header>
                  <div className="action-tag-row">
                    {item.tags.map((tag) => <span className="pill" key={tag}>{tag}</span>)}
                  </div>
                  {item.detail ? <p className="muted">{item.detail}</p> : null}
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {(sheet.personality || sheet.ideal || sheet.bond || sheet.flaw) ? (
          <section className="subcard detail-panel">
            <h3>扮演提示</h3>
            {sheet.personality ? <p>性格：{sheet.personality}</p> : null}
            {sheet.ideal ? <p>理想：{sheet.ideal}</p> : null}
            {sheet.bond ? <p>牵绊：{sheet.bond}</p> : null}
            {sheet.flaw ? <p>缺点：{sheet.flaw}</p> : null}
          </section>
        ) : null}

        {sheet.privateNotes ? (
          <section className="subcard detail-panel detail-wide">
            <h3>私密备注</h3>
            <p>{sheet.privateNotes}</p>
          </section>
        ) : null}
      </div>
    </section>
  );
}
