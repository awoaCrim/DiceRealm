// One durable-in-tab request at a time. Corruption fails closed rather than losing an unknown result.
export async function createPendingStore({ storage, session, cryptoObj = globalThis.crypto }) {
  if (!cryptoObj?.subtle) throw new Error('浏览器缺少安全存储所需的 Web Crypto。');
  const digest = await cryptoObj.subtle.digest('SHA-256',new TextEncoder().encode(session.baseUrl+'|'+session.campaignId+'|'+(session.accountId?'account:'+session.accountId:session.accessToken)));
  const scope = Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  const key = 'dicerealm.workbench.pending.'+scope;
  function read() {
    const raw = storage.getItem(key); if (!raw) return null;
    let record;
    try { record = JSON.parse(raw); } catch { throw new Error('未确认请求的本机记录损坏，已阻止新写入。请保留当前标签页并检查浏览器存储。'); }
    if (!record || typeof record.endpoint !== 'string' || typeof record.payloadJson !== 'string'
      ||record.timelineId!==undefined&&typeof record.timelineId!=='string'
      ||record.draftScope!==undefined&&typeof record.draftScope!=='string') throw new Error('未确认请求的记录不完整，已阻止新写入。');
    JSON.parse(record.payloadJson); return record;
  }
  return { key, scope, read,
    capture(endpoint,payload,{timelineId='',draftScope=scope}={}) {
      if (read()) throw new Error('请先重试未确认的原请求。');
      // Legacy records without this field belong to the initial (empty) timeline.
      const record = { endpoint,payloadJson:JSON.stringify(payload),timelineId,draftScope,createdAt:new Date().toISOString() };
      storage.setItem(key,JSON.stringify(record)); return record;
    },
    complete() { storage.removeItem(key); }
  };
}
