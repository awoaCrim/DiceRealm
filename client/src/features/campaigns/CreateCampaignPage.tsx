import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CreateCampaignResult } from '@dnd/contracts';
import { useCreateCampaign } from '../../entities/campaign/campaignQueries';
import { copyTextToClipboard } from '../../shared/lib/clipboard';
import { PlatformHttpError } from '../../shared/api/platformHttp';
import { AppShell } from '../../shared/ui/AppShell';

/** 创建战役向导：只收集 name+ruleset；成功先进入邀请码保存步骤，显式确认后进入 owner/turn。 */
export function CreateCampaignPage() {
  const navigate = useNavigate();
  const create = useCreateCampaign();
  const [name, setName] = useState('');
  const [ruleset, setRuleset] = useState('dnd5e');
  const [result, setResult] = useState<CreateCampaignResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle');

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setCopyState('idle');
    try {
      const created = await create.mutateAsync({ name: name.trim(), ruleset });
      setResult(created);
    } catch (err) {
      setError(err instanceof PlatformHttpError ? err.message : '创建失败。');
    }
  }

  const inviteLink = useMemo(() => {
    if (!result) {
      return '';
    }
    return new URL(
      `/campaigns/join/${encodeURIComponent(result.campaign.id)}?code=${encodeURIComponent(result.inviteCode)}`,
      window.location.origin,
    ).toString();
  }, [result]);

  async function copyLink() {
    setCopyState(await copyTextToClipboard(inviteLink));
  }

  return (
    <AppShell>
      <h1>创建战役</h1>
      {result ? (
        <section aria-label="保存邀请码">
          <h2>保存邀请码</h2>
          <p>一次性邀请码（仅创建时可见）：</p>
          <code data-testid="invite-code">{result.inviteCode}</code>
          <p>关闭后无法再次查看邀请码。</p>
          <div className="form-field">
            <label htmlFor="invite-link">邀请链接</label>
            <input
              id="invite-link"
              aria-label="邀请链接"
              readOnly
              value={inviteLink}
              onFocus={(e) => e.target.select()}
            />
          </div>
          <button onClick={copyLink}>复制邀请链接</button>
          {copyState === 'copied' ? <p role="status">已复制到剪贴板。</p> : null}
          {copyState === 'manual' ? <p role="status">复制失败，请手动复制。</p> : null}
          <button onClick={() => navigate(`/campaigns/${result.campaign.id}/owner/turn`, { replace: true })}>
            我已保存，进入工作区
          </button>
        </section>
      ) : (
        <form onSubmit={handleCreate}>
          {error ? <div role="alert">{error}</div> : null}
          <div className="form-field">
            <label htmlFor="campaign-name">战役名称</label>
            <input
              id="campaign-name"
              aria-label="战役名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="ruleset">规则集</label>
            <select
              id="ruleset"
              aria-label="规则集"
              value={ruleset}
              onChange={(e) => setRuleset(e.target.value)}
            >
              <option value="dnd5e">dnd5e</option>
            </select>
          </div>
          <button type="submit" disabled={create.isPending}>创建战役</button>
        </form>
      )}
    </AppShell>
  );
}
