import { useEffect, useState, type ChangeEvent } from 'react';
import {
  createResourceImportJob,
  getApprovedCatalogs,
  listResourceImportDrafts,
  listResourceImportJobs,
  reviewResourceImportDraft
} from '../api';
import type { ResourceImportDraft, ResourceImportInput, ResourceImportJob } from '../types';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isImportPayload(value: unknown): value is ResourceImportInput {
  return isObject(value) && typeof value.name === 'string' && Array.isArray(value.drafts);
}

function resourceDraftKindLabel(kind: string | undefined): string {
  switch (kind) {
    case 'rule_entry': return '规则条目';
    case 'character_option': return '角色选项';
    case 'resource_rule': return '资源规则';
    default: return kind || '未知草稿';
  }
}

function resourceDraftCategoryLabel(category: string | null | undefined): string {
  switch (category) {
    case 'combat': return '战斗';
    case 'exploration': return '探索';
    case 'social': return '社交';
    case 'character_creation': return '角色创建';
    case 'equipment': return '装备';
    case 'spellcasting': return '施法';
    case 'resource': return '资源';
    default: return category || '未分类';
  }
}

function resourceVisibilityLabel(visibility: string | undefined): string {
  switch (visibility) {
    case 'public': return '公开';
    case 'private': return '私人';
    case 'dm_only': return '仅主持人';
    default: return visibility || '未指定可见性';
  }
}

export function ResourceReviewPanel({ setError }: { setError: (message: string) => void }) {
  const [jobs, setJobs] = useState<ResourceImportJob[]>([]);
  const [drafts, setDrafts] = useState<ResourceImportDraft[]>([]);
  const [approvedCounts, setApprovedCounts] = useState({ ruleEntries: 0, characterOptions: 0, resourceRules: 0 });
  const [message, setMessage] = useState('');

  async function refresh() {
    const [jobResponse, draftResponse, catalog] = await Promise.all([
      listResourceImportJobs(),
      listResourceImportDrafts({ status: 'pending' }),
      getApprovedCatalogs()
    ]);
    setJobs(jobResponse.jobs);
    setDrafts(draftResponse.drafts);
    setApprovedCounts({
      ruleEntries: catalog.ruleEntries.length,
      characterOptions: catalog.characterOptions.length,
      resourceRules: catalog.resourceRules.length
    });
  }

  useEffect(() => {
    refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function importFile(file: File | undefined) {
    if (!file) return;
    setError('');
    setMessage('');
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text()) as unknown;
      } catch (error) {
        throw new Error(`资源导入文件不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
      }
      if (!isImportPayload(parsed)) throw new Error('资源导入 JSON 必须包含 name 和 drafts。');
      const result = await createResourceImportJob(parsed);
      setMessage(`已导入 ${result.drafts.length} 条待审核草稿。`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    try {
      await importFile(file);
    } finally {
      input.value = '';
    }
  }

  async function approveDraft(draftId: string) {
    setError('');
    try {
      await reviewResourceImportDraft(draftId, { status: 'approved' });
      setMessage('草稿已批准。');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function rejectDraft(draftId: string) {
    setError('');
    try {
      await reviewResourceImportDraft(draftId, { status: 'rejected', rejectionReason: '管理员在审核列表中拒绝。' });
      setMessage('草稿已拒绝。');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="subcard">
      <h3>资源导入与审核</h3>
      <p className="muted">导入 PHB、世界书或规则数据库抽取 JSON；只有批准后的草稿会进入稳定目录。</p>
      <label>结构化资源 JSON<input type="file" accept="application/json,.json" onChange={(event) => void handleFileChange(event)} /></label>
      <p>导入批次：{jobs.length}</p>
      <p>待审核草稿：{drafts.length}</p>
      <p>已批准规则条目：{approvedCounts.ruleEntries}</p>
      <p>已批准角色选项：{approvedCounts.characterOptions}</p>
      <p>已批准资源规则：{approvedCounts.resourceRules}</p>
      {message ? <p>{message}</p> : null}
      {drafts.length ? (
        <div>
          {drafts.map((draft) => (
            <article className="subcard" key={draft.id}>
              <h4>{draft.title}</h4>
              <p className="muted">{resourceDraftKindLabel(draft.kind)} / {resourceDraftCategoryLabel(draft.category)} · {resourceVisibilityLabel(draft.visibility)}</p>
              <p>{draft.summary}</p>
              {draft.content ? <p>{draft.content}</p> : null}
              {draft.sourceRef ? <p className="muted">来源：{draft.sourceRef}</p> : null}
              <div className="button-row">
                <button onClick={() => void approveDraft(draft.id)}>批准</button>
                <button onClick={() => void rejectDraft(draft.id)}>拒绝</button>
              </div>
            </article>
          ))}
        </div>
      ) : <p className="muted">暂无待审核资源草稿。</p>}
    </div>
  );
}
