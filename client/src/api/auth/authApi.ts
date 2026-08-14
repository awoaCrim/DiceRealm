import type { LoginInput, RegisterInput, AuthenticatedUser } from '@dnd/contracts';
import { platformRequest } from '../../shared/api/platformHttp';
import {
  okEnvelopeSchema,
  sessionEnvelopeSchema,
  userEnvelopeSchema,
} from '../../shared/lib/contractSchemas';

/** 注册：成功不自动登录（服务端不设 cookie）。 */
export async function register(input: RegisterInput): Promise<AuthenticatedUser> {
  const { user } = await platformRequest('/api/auth/register', {
    method: 'POST',
    body: input,
    responseSchema: userEnvelopeSchema,
  });
  return user;
}

/** 登录：服务端设置 __Host-dnd_session 与 __Host-dnd_csrf cookie。 */
export async function login(input: LoginInput): Promise<void> {
  await platformRequest('/api/auth/login', {
    method: 'POST',
    body: input,
    responseSchema: sessionEnvelopeSchema,
  });
}

/** 当前会话用户；AUTH_REQUIRED 由调用方（session query）转为 guest。 */
export async function me(): Promise<AuthenticatedUser> {
  const { user } = await platformRequest('/api/auth/me', {
    responseSchema: userEnvelopeSchema,
  });
  return user;
}

/** 注销：服务端删除会话并清除 cookie。 */
export async function logout(): Promise<void> {
  await platformRequest('/api/auth/logout', {
    method: 'POST',
    responseSchema: okEnvelopeSchema,
  });
}
