import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import type { RuleSource, RuleSourceRegistrationInput } from '@dnd/contracts';
import { useRegisterRuleSource, useRuleSources } from '../../../entities/rules/ruleQueries';
import { AsyncState } from '../../../shared/ui/AsyncState';

const SCOPE_LABEL: Record<RuleSource['scope'], string> = {
  platform: '平台来源',
  campaign: '当前战役',
  user: '我的来源',
};

const emptyForm: RuleSourceRegistrationInput = {
  sourceName: '',
  version: '',
  license: '',
  attribution: '',
  contentHash: '',
  scope: 'campaign',
};

/** Owner rule-source registry. It registers provenance metadata, never rule text. */
export function OwnerRulesPage() {
  const { campaignId = '' } = useParams();
  const sources = useRuleSources(campaignId);
  const registerSource = useRegisterRuleSource(campaignId);
  const [form, setForm] = useState<RuleSourceRegistrationInput>(emptyForm);
  const [success, setSuccess] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSuccess(false);
    try {
      await registerSource.mutateAsync(form);
      setForm(emptyForm);
      setSuccess(true);
    } catch {
      // Mutation state renders the safe platform error below.
    }
  };

  return (
    <div className="owner-rules">
      <h1>规则资料</h1>
      <p className="ai-managed-note">
        只登记来源、版本、许可证、署名与外部文件 SHA-256 哈希；平台不会上传或保存规则正文。
      </p>

      <AsyncState
        status={sources.isPending ? 'loading' : sources.isError ? 'error' : 'ready'}
        label="规则来源"
        errorMessage={sources.error instanceof Error ? sources.error.message : ''}
        onRetry={() => void sources.refetch()}
      >
        <section className="owner-rules__registry" aria-label="规则来源列表">
          <div className="section-heading">
            <div>
              <h2>已登记来源</h2>
              <p>平台来源、当前战役来源，以及你的跨战役个人来源。</p>
            </div>
            <span className="count-badge">{sources.data?.length ?? 0} 个来源</span>
          </div>
          {!sources.data?.length ? (
            <div className="ai-managed-empty">
              <h3>暂无规则来源</h3>
              <p>可在下方登记你有权使用的来源元数据。</p>
            </div>
          ) : (
            <ul className="rule-source-list">
              {sources.data.map((source) => <RuleSourceCard key={source.id} source={source} />)}
            </ul>
          )}
        </section>
      </AsyncState>

      <form className="owner-rules__form" onSubmit={(event) => void submit(event)}>
        <div className="section-heading">
          <div>
            <h2>登记来源</h2>
            <p>哈希是外部文件的身份标识；请在本机计算 SHA-256 后填写。</p>
          </div>
        </div>
        <div className="rule-source-form-grid">
          <label htmlFor="rule-source-name">
            来源名称
            <input id="rule-source-name" value={form.sourceName} onChange={(event) => setForm({ ...form, sourceName: event.target.value })} required />
          </label>
          <label htmlFor="rule-source-version">
            版本
            <input id="rule-source-version" value={form.version} onChange={(event) => setForm({ ...form, version: event.target.value })} required />
          </label>
          <label htmlFor="rule-source-scope">
            适用范围
            <select id="rule-source-scope" value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value as RuleSourceRegistrationInput['scope'] })}>
              <option value="campaign">当前战役</option>
              <option value="user">我的所有战役</option>
            </select>
          </label>
          <label htmlFor="rule-source-license">
            许可证
            <input id="rule-source-license" value={form.license} onChange={(event) => setForm({ ...form, license: event.target.value })} required />
          </label>
          <label htmlFor="rule-source-attribution">
            署名
            <input id="rule-source-attribution" value={form.attribution} onChange={(event) => setForm({ ...form, attribution: event.target.value })} required />
          </label>
          <label htmlFor="rule-source-hash" className="rule-source-form-grid__wide">
            SHA-256 内容哈希
            <input
              id="rule-source-hash"
              value={form.contentHash}
              onChange={(event) => setForm({ ...form, contentHash: event.target.value.trim().toLowerCase() })}
              pattern="[A-Fa-f0-9]{64}"
              minLength={64}
              maxLength={64}
              spellCheck={false}
              autoComplete="off"
              required
            />
          </label>
        </div>
        <button type="submit" disabled={registerSource.isPending}>
          {registerSource.isPending ? '正在登记…' : '登记来源'}
        </button>
        {success ? <p className="form-feedback form-feedback--success" role="status">规则来源已登记。</p> : null}
        {registerSource.isError ? (
          <p className="form-feedback form-feedback--error" role="alert">
            {registerSource.error instanceof Error ? registerSource.error.message : '规则来源登记失败。'}
          </p>
        ) : null}
      </form>
    </div>
  );
}

function RuleSourceCard({ source }: { source: RuleSource }) {
  return (
    <li className="rule-source-card">
      <div className="rule-source-card__heading">
        <div>
          <span className={`rule-source-scope rule-source-scope--${source.scope}`}>{SCOPE_LABEL[source.scope]}</span>
          <h3>{source.sourceName}</h3>
        </div>
        <strong>v{source.version}</strong>
      </div>
      <dl>
        <dt>许可证</dt><dd>{source.license}</dd>
        <dt>署名</dt><dd>{source.attribution}</dd>
        <dt>SHA-256</dt><dd><code title={source.contentHash}>{source.contentHash}</code></dd>
      </dl>
    </li>
  );
}
