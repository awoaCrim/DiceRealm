export const SESSION_KEY = 'dicerealm.workbench.session.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/i;

export function normalizeSession(value, origin) {
  if (!value || typeof value !== 'object') throw new Error('连接文件不完整。');
  const url = new URL(value.baseUrl || origin);
  if (url.origin !== origin || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('连接文件的服务地址与当前网页不同。请打开对应服务的工作台，凭证没有发送。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)))
    throw new Error('远程工作台必须使用 HTTPS。');
  const campaignId = String(value.campaignId || '').trim();
  const accessToken = String(value.accessToken || '').trim();
  if (!UUID.test(campaignId) || !TOKEN.test(accessToken)) throw new Error('请输入有效的战役编号和 64 位访问凭证。');
  const accountId=value.accountId;
  if(accountId!==undefined&&(typeof accountId!=='string'||!accountId||accountId.length>128))throw new Error('账户连接身份无效。');
  return { baseUrl: origin, campaignId, accessToken, ...(accountId?{accountId}:{}) };
}
export function loadSession(storage, origin) {
  const saved = storage.getItem(SESSION_KEY);
  return saved ? normalizeSession(JSON.parse(saved),origin) : null;
}
export function saveSession(storage, session, origin) {
  const normalized = normalizeSession(session,origin);
  storage.setItem(SESSION_KEY,JSON.stringify(normalized)); return normalized;
}
export function clearSession(storage) { storage.removeItem(SESSION_KEY); }
