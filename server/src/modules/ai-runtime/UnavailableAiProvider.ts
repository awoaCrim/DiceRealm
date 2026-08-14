import type { AiProviderPublicConfig } from '@dnd/contracts';
import { AppError } from '../../platform/http/AppError.js';
import type { AiPreviewHooks, AiProviderPort } from './AiProviderPort.js';
import type { AiPrompt } from '@dnd/contracts';

/** 生产默认 Provider：resolve 安全失败 AI_PROVIDER_FAILED，绝不默认 Mock。 */
export class UnavailableAiProvider implements AiProviderPort {
  readonly name = 'unavailable';
  readonly model = 'unavailable';
  readonly publicConfig: AiProviderPublicConfig = {
    provider: 'unavailable',
    baseUrl: '',
    model: 'unavailable',
    configured: false,
    apiKeyConfigured: false,
    source: 'unavailable',
  };
  async stream(_input: AiPrompt, _hooks: AiPreviewHooks): Promise<unknown> {
    throw new AppError('AI_PROVIDER_FAILED', '未配置 AI Provider，无法结算回合。');
  }
}
