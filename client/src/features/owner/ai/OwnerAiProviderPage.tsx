import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import type { AiProviderConfigInput, AiProviderPublicConfig } from '@dnd/contracts';
import * as aiApi from '../../../api/ai/aiApi';
import { useAiProviderStatus } from '../../../entities/ai/aiQueries';
import { AsyncState } from '../../../shared/ui/AsyncState';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
type RequestState = 'idle' | 'pending' | 'success' | 'error';

/** Owner Provider 配置页：测试连接、写入式 API Key、加密保存并立即切换战役运行时。 */
export function OwnerAiProviderPage() {
  const { campaignId = '' } = useParams();
  const queryClient = useQueryClient();
  const status = useAiProviderStatus(campaignId);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [apiKey, setApiKey] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [testState, setTestState] = useState<RequestState>('idle');
  const [testError, setTestError] = useState('');
  const [saveState, setSaveState] = useState<RequestState>('idle');
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (!status.data || initialized) return;
    setBaseUrl(status.data.baseUrl || DEFAULT_BASE_URL);
    setModel(status.data.model && status.data.model !== 'unavailable' ? status.data.model : DEFAULT_MODEL);
    setInitialized(true);
  }, [initialized, status.data]);

  const input = (): AiProviderConfigInput => ({
    provider: 'openai-compatible',
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    apiKey,
  });

  const testConnection = async () => {
    setTestState('pending');
    setTestError('');
    try {
      // Deliberately call the API directly instead of useMutation: the API Key
      // must never be retained in TanStack Query's mutation cache.
      await aiApi.testProviderConfig(campaignId, input());
      setTestState('success');
    } catch (error) {
      setTestState('error');
      setTestError(error instanceof Error ? error.message : '连接测试失败。');
    }
  };

  const submitSave = async (event: FormEvent) => {
    event.preventDefault();
    setSaveState('pending');
    setSaveError('');
    try {
      // The write-only key exists only in component memory for the request and
      // is cleared after success; only the sanitized response enters Query Cache.
      const provider = await aiApi.saveProviderConfig(campaignId, input());
      queryClient.setQueryData(['campaign', campaignId, 'ai-provider-status'], provider);
      setApiKey('');
      setTestState('idle');
      setSaveState('success');
    } catch (error) {
      setSaveState('error');
      setSaveError(error instanceof Error ? error.message : '配置保存失败。');
    }
  };

  const busy = testState === 'pending' || saveState === 'pending';

  return (
    <div className="owner-ai-provider">
      <h1>AI 接口</h1>
      <p className="ai-managed-note">
        在这里配置当前战役的 AI Provider。API Key 只写入一次，服务端加密保存，保存后不会回显，并立即用于后续 AI 结算。
      </p>
      <AsyncState
        status={status.isPending ? 'loading' : status.isError ? 'error' : 'ready'}
        label="AI 接口状态"
        errorMessage={status.error instanceof Error ? status.error.message : ''}
        onRetry={() => void status.refetch()}
      >
        {status.data ? <ProviderStatusCard provider={status.data} /> : null}
      </AsyncState>

      <form className="owner-ai-provider__form" onSubmit={(event) => void submitSave(event)}>
        <div className="section-heading">
          <div>
            <h2>接口配置</h2>
            <p>支持 OpenAI-compatible Chat Completions 接口。</p>
          </div>
        </div>

        <label htmlFor="ai-provider-kind">
          Provider
          <select id="ai-provider-kind" value="openai-compatible" disabled>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </label>
        <label htmlFor="ai-provider-base-url">
          API 地址
          <input
            id="ai-provider-base-url"
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={DEFAULT_BASE_URL}
            required
            autoComplete="off"
          />
        </label>
        <label htmlFor="ai-provider-model">
          模型
          <input
            id="ai-provider-model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={DEFAULT_MODEL}
            required
            autoComplete="off"
          />
        </label>
        <label htmlFor="ai-provider-api-key">
          API Key
          <input
            id="ai-provider-api-key"
            aria-label="API Key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={status.data?.apiKeyConfigured ? '已配置；留空则沿用现有密钥' : '请输入 API Key'}
            required={!status.data?.apiKeyConfigured}
            autoComplete="new-password"
            spellCheck={false}
          />
          <span className="field-help">
            {status.data?.apiKeyConfigured ? 'API Key 已配置；如需更换，请输入新密钥。' : '首次保存必须填写 API Key。'}
          </span>
        </label>

        <div className="owner-ai-provider__actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void testConnection()}
          >
            {testState === 'pending' ? '正在测试…' : '测试连接'}
          </button>
          <button type="submit" disabled={busy}>
            {saveState === 'pending' ? '正在保存…' : '保存并立即启用'}
          </button>
        </div>

        {testState === 'success' ? <p className="form-feedback form-feedback--success" role="status">连接测试成功。</p> : null}
        {testState === 'error' ? <p className="form-feedback form-feedback--error" role="alert">{testError}</p> : null}
        {saveState === 'success' ? <p className="form-feedback form-feedback--success" role="status">配置已加密保存并立即生效。</p> : null}
        {saveState === 'error' ? <p className="form-feedback form-feedback--error" role="alert">{saveError}</p> : null}
      </form>

      <section className="owner-ai-provider__security" aria-label="凭证安全说明">
        <h2>凭证安全</h2>
        <ul>
          <li>API Key 为写入式字段：保存后只显示“已配置”，不会返回原值。</li>
          <li>服务端首次启动时自动生成本地密钥，并使用 AES-256-GCM 加密后落库，无需手动配置主密钥。</li>
          <li>API Key 不进入 AI 日志、运行详情、错误响应或浏览器 Query/Mutation Cache。</li>
        </ul>
      </section>
    </div>
  );
}

function ProviderStatusCard({ provider }: { provider: AiProviderPublicConfig }) {
  const sourceLabel = provider.source === 'campaign'
    ? '当前战役 WebUI 配置'
    : provider.source === 'environment'
      ? '服务端环境变量回退'
      : provider.source === 'injected'
        ? '测试运行时注入'
        : '未配置';
  return (
    <section className="owner-ai-provider__status" aria-label="当前 AI 接口状态">
      <div className={provider.configured ? 'provider-status provider-status--ready' : 'provider-status provider-status--warning'}>
        <strong>{provider.configured ? '已配置，可用于 AI 结算' : '未配置，AI 结算会安全失败'}</strong>
        <span>{provider.configured ? `${sourceLabel}已生效。` : '请填写下方配置并保存。'}</span>
      </div>
      <dl>
        <dt>当前来源</dt>
        <dd>{sourceLabel}</dd>
        <dt>API 地址</dt>
        <dd>{provider.baseUrl || '未设置'}</dd>
        <dt>模型</dt>
        <dd>{provider.model === 'unavailable' ? '未设置' : provider.model || '未设置'}</dd>
        <dt>API Key</dt>
        <dd>{provider.apiKeyConfigured ? 'API Key 已配置' : '未配置'}</dd>
      </dl>
    </section>
  );
}
