# 前端布局与预设块折叠 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将管理页改为任务导向标签页，并让预设提示词块可折叠，同时保持首页、玩家页、现有导入/绑定行为清晰可用。

**Architecture:** 只改前端：`AdminPage` 继续负责数据加载和 mutation，新增本地 tab state 与 preset block expanded state。样式通过现有 `styles.css` 增加少量 utility class，不引入 UI 库，不改后端 API。

**Tech Stack:** React + TypeScript + Vite + Vitest + Testing Library。

---

## File Structure

- Modify: `client/src/pages/AdminPage.tsx`
  - Add `AdminTab` type and local `activeTab` state.
  - Move existing admin sections into tab-specific render blocks.
  - Add collapsible preset block editor state and behavior.
  - Preserve existing `aiConfigDirtyRef`, `presetDraft`, resource binding, and refresh behavior.
- Modify: `client/src/styles.css`
  - Add tab, button-row, section header, and collapsible preset block styles.
  - Keep current dark DND theme.
  - Do not add mobile-specific layout work.
- Modify: `client/src/ui-copy.test.tsx`
  - Update admin UI smoke test for tabs.
  - Add focused tests for resource tab visibility and preset block collapse/expand behavior.

No backend files should be modified. Do not modify `SillyTavern/`. Do not create commits unless explicitly requested by the user.

---

### Task 1: Add admin tabs and move existing panels behind tabs

**Files:**
- Modify: `client/src/pages/AdminPage.tsx`
- Modify: `client/src/ui-copy.test.tsx`

- [ ] **Step 1: Write failing tab navigation test**

Add `userEvent` coverage to `client/src/ui-copy.test.tsx` inside `describe('中文界面文案', ...)`. Keep existing tests, and update the admin-page test so it expects tab buttons first, then clicks tabs to reveal tab-specific panels.

```tsx
it('管理员页使用标签页组织主要工作流', async () => {
  const user = userEvent.setup();
  render(<AdminPage roomId="room-1" />);

  expect(await screen.findByRole('button', { name: '总览' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'AI 约束' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '资源' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '预设' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '世界书' })).toBeInTheDocument();

  expect(screen.getByText('玩家')).toBeInTheDocument();
  expect(screen.getByText('全部日志')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'AI 约束' }));
  expect(screen.getByText('核心规则')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '保存 AI 约束' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '预览 AI 请求' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '资源' }));
  expect(screen.getByText('全局资源库 / 导入')).toBeInTheDocument();
  expect(screen.getByText('房间资源绑定')).toBeInTheDocument();
  expect(screen.getByText('导入 ST 角色卡为剧本卡')).toBeInTheDocument();
  expect(screen.getByText('ST 兼容预设包')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '预设' }));
  expect(screen.getByText('预设管理')).toBeInTheDocument();
  expect(screen.getByText('默认强约束预设（当前启用）')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '世界书' }));
  expect(screen.getByText('世界书')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '创建世界书' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '添加世界书条目' })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test -- --run client/src/ui-copy.test.tsx
```

Expected: FAIL because `总览` / tab buttons do not exist yet.

- [ ] **Step 3: Add tab state and tab buttons in `AdminPage`**

In `client/src/pages/AdminPage.tsx`, add this type near imports:

```tsx
type AdminTab = 'overview' | 'ai' | 'resources' | 'presets' | 'worldBooks';

const adminTabs: Array<{ id: AdminTab; label: string }> = [
  { id: 'overview', label: '总览' },
  { id: 'ai', label: 'AI 约束' },
  { id: 'resources', label: '资源' },
  { id: 'presets', label: '预设' },
  { id: 'worldBooks', label: '世界书' }
];
```

Inside `AdminPage`, add state:

```tsx
const [activeTab, setActiveTab] = useState<AdminTab>('overview');
```

Near the top of the rendered `<main>`, after the room status paragraph, add tab buttons:

```tsx
<nav className="tabs" aria-label="管理页功能区">
  {adminTabs.map((tab) => (
    <button
      className={`tab-button${activeTab === tab.id ? ' active' : ''}`}
      key={tab.id}
      onClick={() => setActiveTab(tab.id)}
      type="button"
    >
      {tab.label}
    </button>
  ))}
</nav>
```

- [ ] **Step 4: Move existing admin panels into conditional tab sections**

Still in `AdminPage`, replace the current always-visible `grid` content with tab sections. Preserve the existing JSX content, callbacks, props, and state. The final structure should be:

```tsx
{activeTab === 'overview' ? (
  <div className="grid">
    <aside className="card">
      <h2>玩家</h2>
      {state.players.map((player) => <p key={player.id}>{player.name}</p>)}
      <input value={playerName} onChange={(event) => setPlayerName(event.target.value)} />
      <div className="button-row"><button onClick={createPlayer}>创建玩家链接</button></div>
      {lastLink ? <p><a href={lastLink}>{lastLink}</a></p> : null}
      <h2>行动</h2>
      {state.actions.map((action) => <p key={action.id}>{action.playerId}: {action.text}</p>)}
      <div className="button-row"><button onClick={advance}>处理本回合</button></div>
      {error ? <p>{error}</p> : null}
      <h2>AI 错误</h2>
      {state.aiGenerations.filter((gen) => gen.error).map((gen) => <p key={gen.id}>{gen.error}</p>)}
    </aside>
    <section>
      <LogList title="全部日志" logs={state.logs} />
    </section>
  </div>
) : null}

{activeTab === 'ai' && aiConfig ? (
  <section className="card">
    <h2>AI 约束</h2>
    <p className="muted">像 SillyTavern 预设一样，按固定顺序约束 AI-DM 的身份、玩家自主权、信息隔离、互动裁定、叙事风格和输出格式。</p>
    <label>核心规则<textarea value={aiConfig.coreRules} onChange={(event) => updateAiConfig('coreRules', event.target.value)} /></label>
    <label>玩家自主权规则<textarea value={aiConfig.playerAgencyRules} onChange={(event) => updateAiConfig('playerAgencyRules', event.target.value)} /></label>
    <label>信息隔离规则<textarea value={aiConfig.visibilityRules} onChange={(event) => updateAiConfig('visibilityRules', event.target.value)} /></label>
    <label>玩家互动规则<textarea value={aiConfig.interactionRules} onChange={(event) => updateAiConfig('interactionRules', event.target.value)} /></label>
    <label>叙事风格规则<textarea value={aiConfig.styleRules} onChange={(event) => updateAiConfig('styleRules', event.target.value)} /></label>
    <label>输出格式规则<textarea value={aiConfig.outputFormatRules} onChange={(event) => updateAiConfig('outputFormatRules', event.target.value)} /></label>
    <div className="button-row">
      <button onClick={persistAiConfig}>保存 AI 约束</button>
      <button onClick={loadPromptPreview}>预览 AI 请求</button>
    </div>
    <PromptPreviewPanel preview={promptPreview} />
  </section>
) : null}

{activeTab === 'resources' ? (
  <section>
    <ResourceImportPanel
      scriptCards={state.scriptCards}
      resourceWorldBooks={state.resourceWorldBooks}
      presetPackages={state.presetPackages}
      onImported={refresh}
      setError={setError}
    />
    <RoomResourceBindingsPanel
      roomId={roomId}
      scriptCards={state.scriptCards}
      resourceWorldBooks={state.resourceWorldBooks}
      presetPackages={state.presetPackages}
      roomScriptBinding={state.roomScriptBinding}
      roomWorldBookBindings={state.roomWorldBookBindings}
      roomPresetBinding={state.roomPresetBinding}
      onChanged={refresh}
      setError={setError}
    />
  </section>
) : null}

{activeTab === 'presets' ? (
  <section className="card">
    <h2>预设管理</h2>
    <p className="muted">像 SillyTavern 预设一样管理多个提示词块，可启用、排序并决定注入位置。</p>
    {/* keep the existing preset list and editor JSX here; Task 2 changes block editor */}
  </section>
) : null}

{activeTab === 'worldBooks' ? (
  <section className="card">
    <h2>世界书</h2>
    <p className="muted">按关键词扫描世界信息、公开日志和本轮行动，命中后把条目注入 AI 上下文。</p>
    {/* keep the existing world book creation and entry JSX here */}
  </section>
) : null}
```

- [ ] **Step 5: Run focused test**

Run:

```bash
rtk npm test -- --run client/src/ui-copy.test.tsx
```

Expected: PASS for the tab navigation test. If existing tests fail because they expect panels before clicking tabs, update them to click the relevant tab first.

---

### Task 2: Add collapsible prompt preset blocks

**Files:**
- Modify: `client/src/pages/AdminPage.tsx`
- Modify: `client/src/ui-copy.test.tsx`

- [ ] **Step 1: Update AdminState mock with preset blocks**

In `client/src/ui-copy.test.tsx`, make the mocked preset include at least two blocks so collapse/expand behavior can be tested:

```tsx
blocks: [
  {
    id: 'block-core',
    name: '核心规则',
    role: 'system',
    position: 'before_world',
    enabled: true,
    orderIndex: 10,
    content: '核心规则内容'
  },
  {
    id: 'block-output',
    name: '输出格式规则',
    role: 'system',
    position: 'final',
    enabled: true,
    orderIndex: 100,
    content: '输出格式内容'
  }
]
```

- [ ] **Step 2: Write failing collapse/expand test**

Add this test in `client/src/ui-copy.test.tsx`:

```tsx
it('预设提示词块可以折叠展开，新增块自动展开', async () => {
  const user = userEvent.setup();
  render(<AdminPage roomId="room-1" />);

  await screen.findByRole('button', { name: '预设' });
  await user.click(screen.getByRole('button', { name: '预设' }));
  await user.click(screen.getByRole('button', { name: '编辑预设' }));

  expect(screen.getByRole('button', { name: /核心规则/ })).toBeInTheDocument();
  expect(screen.queryByDisplayValue('核心规则内容')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /核心规则/ }));
  expect(screen.getByDisplayValue('核心规则内容')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /输出格式规则/ }));
  expect(screen.getByDisplayValue('输出格式内容')).toBeInTheDocument();
  expect(screen.queryByDisplayValue('核心规则内容')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /输出格式规则/ }));
  expect(screen.queryByDisplayValue('输出格式内容')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '新增提示词块' }));
  expect(screen.getByDisplayValue('新的约束内容。')).toBeInTheDocument();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
rtk npm test -- --run client/src/ui-copy.test.tsx
```

Expected: FAIL because preset blocks are not collapsible yet.

- [ ] **Step 4: Implement expanded block state**

In `client/src/pages/AdminPage.tsx`, add state inside `AdminPage`:

```tsx
const [expandedPresetBlockKey, setExpandedPresetBlockKey] = useState<string | null>(null);
```

Add this helper inside `AdminPage`:

```tsx
function presetBlockKey(block: PromptBlock, index: number): string {
  return block.id ?? `new-${index}`;
}
```

Update `startEditingPreset` to collapse existing blocks by default:

```tsx
function startEditingPreset(preset: PromptPreset) {
  setPresetDraft({ ...preset, blocks: preset.blocks.map((block) => ({ ...block })) });
  setExpandedPresetBlockKey(null);
}
```

Update `addPresetBlock` to expand the new block:

```tsx
function addPresetBlock() {
  setPresetDraft((current) => {
    if (!current) return current;
    const nextIndex = current.blocks.length;
    setExpandedPresetBlockKey(`new-${nextIndex}`);
    return {
      ...current,
      blocks: [...current.blocks, { name: '新增提示词块', role: 'system', position: 'before_actions', enabled: true, orderIndex: 100, content: '新的约束内容。' }]
    };
  });
}
```

Add toggle helper:

```tsx
function togglePresetBlock(block: PromptBlock, index: number) {
  const key = presetBlockKey(block, index);
  setExpandedPresetBlockKey((current) => current === key ? null : key);
}
```

- [ ] **Step 5: Replace preset block editor markup with collapsible markup**

In the `presetDraft.blocks.map(...)` JSX, replace the always-open block form with:

```tsx
{presetDraft.blocks.map((block, index) => {
  const blockKey = presetBlockKey(block, index);
  const expanded = expandedPresetBlockKey === blockKey;
  return (
    <div className="subcard collapsible-card" key={blockKey}>
      <button className="collapsible-header" type="button" onClick={() => togglePresetBlock(block, index)}>
        <span>{expanded ? '收起' : '展开'} · {block.name || '未命名提示词块'}</span>
        <span className="meta-row">{block.position} · {block.role} · {block.enabled ? '启用' : '停用'} · 排序 {block.orderIndex}</span>
      </button>
      {expanded ? (
        <div className="collapsible-body">
          <label>块名称<input value={block.name} onChange={(event) => updatePresetBlock(index, { name: event.target.value })} /></label>
          <label>注入位置
            <select value={block.position} onChange={(event) => updatePresetBlock(index, { position: event.target.value as PromptBlock['position'] })}>
              <option value="before_world">世界信息前</option>
              <option value="after_world">世界信息后</option>
              <option value="before_actions">行动前</option>
              <option value="after_actions">行动后</option>
              <option value="final">最终输出前</option>
            </select>
          </label>
          <label>排序<input type="number" value={block.orderIndex} onChange={(event) => updatePresetBlock(index, { orderIndex: Number(event.target.value) })} /></label>
          <label className="check-row"><input type="checkbox" checked={block.enabled} onChange={(event) => updatePresetBlock(index, { enabled: event.target.checked })} /> 启用此块</label>
          <textarea value={block.content} onChange={(event) => updatePresetBlock(index, { content: event.target.value })} />
        </div>
      ) : null}
    </div>
  );
})}
```

- [ ] **Step 6: Run focused test**

Run:

```bash
rtk npm test -- --run client/src/ui-copy.test.tsx
```

Expected: PASS.

---

### Task 3: Add layout styling and small page clarity improvements

**Files:**
- Modify: `client/src/styles.css`
- Modify: `client/src/pages/HomePage.tsx`
- Modify: `client/src/pages/PlayerPage.tsx`
- Modify: `client/src/pages/AdminPage.tsx`

- [ ] **Step 1: Add style utilities**

Append these styles to `client/src/styles.css`:

```css
.page-header {
  margin-bottom: 20px;
}

.page-header h1 {
  margin-bottom: 0.35rem;
}

.tabs {
  display: flex;
  gap: 10px;
  margin: 18px 0 20px;
  padding: 8px;
  border: 1px solid rgba(232, 182, 91, 0.18);
  border-radius: 16px;
  background: rgba(0, 0, 0, 0.2);
}

.tab-button {
  margin: 0;
  background: rgba(232, 182, 91, 0.14);
  color: #f4ead7;
}

.tab-button.active {
  background: #e8b65b;
  color: #1d130b;
}

.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin-top: 0.75rem;
}

.button-row button {
  margin-top: 0;
}

.button-row button + button {
  margin-left: 0;
}

.collapsible-card {
  padding: 0;
  overflow: hidden;
}

.collapsible-header {
  display: flex;
  width: 100%;
  justify-content: space-between;
  gap: 1rem;
  align-items: center;
  margin: 0;
  border-radius: 0;
  background: rgba(232, 182, 91, 0.12);
  color: #f4ead7;
  text-align: left;
}

.collapsible-body {
  padding: 0.9rem;
}

.meta-row {
  color: #bba88d;
  font-size: 0.9rem;
  font-weight: 500;
}
```

- [ ] **Step 2: Wrap page headers**

In `HomePage`, wrap the title and description in a `page-header` div inside the card:

```tsx
<div className="page-header">
  <h1>DND AI-DM</h1>
  <p className="muted">创建本地多人跑团房间，并为每位玩家隔离可见信息。</p>
</div>
```

In `PlayerPage`, wrap the title and player summary:

```tsx
<div className="page-header">
  <h1>{state.room.name}</h1>
  <p className="muted">玩家视图 · {state.player.name}</p>
</div>
```

In `AdminPage`, wrap the title and room summary:

```tsx
<div className="page-header">
  <h1>{state.room.name}</h1>
  <p className="muted">主持人控制台 · 第 {state.room.currentTurn} 回合 · {state.room.status}</p>
</div>
```

- [ ] **Step 3: Use button rows for grouped actions**

Where adjacent buttons exist in `AdminPage`, `PlayerPage`, `ResourceImportPanel`, and `RoomResourceBindingsPanel`, wrap related buttons in `<div className="button-row">...</div>` without changing button text or handlers. Examples:

```tsx
<div className="button-row">
  <button onClick={persistAiConfig}>保存 AI 约束</button>
  <button onClick={loadPromptPreview}>预览 AI 请求</button>
</div>
```

```tsx
<div className="button-row">
  <button onClick={() => void bindScriptCard()} disabled={!selectedScriptCardId}>绑定主剧本卡</button>
  <button onClick={() => void unbindScriptCard()} disabled={!roomScriptBinding}>解绑主剧本卡</button>
</div>
```

- [ ] **Step 4: Run focused UI tests**

Run:

```bash
rtk npm test -- --run client/src/ui-copy.test.tsx
```

Expected: PASS.

---

### Task 4: Full validation and browser verification

**Files:**
- No source changes unless validation finds a bug.

- [ ] **Step 1: Run full tests**

Run:

```bash
rtk npm test
```

Expected: PASS for all test files.

- [ ] **Step 2: Run typecheck**

Run:

```bash
rtk npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```bash
rtk npm run build
```

Expected: PASS.

- [ ] **Step 4: Browser verification**

Run the dev server:

```bash
rtk npm run dev
```

Verify in browser:
- Homepage loads and creates a room.
- Admin page shows tabs: `总览`, `AI 约束`, `资源`, `预设`, `世界书`.
- `AI 约束` tab shows AI constraint fields and prompt preview button.
- `资源` tab shows resource import and room resource binding panels.
- `预设` tab shows preset management; editing a preset shows collapsed prompt block headers; headers expand/collapse; adding a block expands the new block.
- `世界书` tab shows native world book creation and entry UI.
- Create a player link and open the player page; player view still renders.

- [ ] **Step 5: Cleanup generated files**

Check generated files:

```bash
rtk git status --short
rtk git check-ignore -v server/dnd.sqlite server/dist client/dist
```

Expected:
- No unexpected temporary files.
- `server/dnd.sqlite`, `server/dist`, and `client/dist` are ignored.
- Do not commit unless the user explicitly asks.
