import { useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useJoinCampaign } from '../../entities/campaign/campaignQueries';
import { PlatformHttpError } from '../../shared/api/platformHttp';
import { AppShell } from '../../shared/ui/AppShell';

/** 加入战役：从 path 取 campaignId、query 预填 code；确认后 POST /:campaignId/join。 */
export function JoinCampaignPage() {
  const { campaignId: paramCampaignId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const join = useJoinCampaign();
  const [campaignId, setCampaignId] = useState(paramCampaignId ?? '');
  const [code, setCode] = useState(searchParams.get('code') ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleJoin(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const id = campaignId.trim();
    const inviteCode = code.trim();
    if (!id || !inviteCode) {
      setError('请填写战役 ID 与邀请码。');
      return;
    }
    setPending(true);
    try {
      await join.mutateAsync({ campaignId: id, code: inviteCode });
      navigate(`/campaigns/${encodeURIComponent(id)}/player/story`, { replace: true });
    } catch (err) {
      setError(err instanceof PlatformHttpError ? err.message : '加入失败。');
    } finally {
      setPending(false);
    }
  }

  return (
    <AppShell>
      <h1>加入战役</h1>
      {error ? <div role="alert">{error}</div> : null}
      <form onSubmit={handleJoin}>
        <div className="form-field">
          <label htmlFor="join-campaign-id">战役 ID</label>
          <input
            id="join-campaign-id"
            aria-label="战役 ID"
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            required
          />
        </div>
        <div className="form-field">
          <label htmlFor="join-code">邀请码</label>
          <input
            id="join-code"
            aria-label="邀请码"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
        </div>
        <button type="submit" disabled={pending}>加入战役</button>
      </form>
    </AppShell>
  );
}
