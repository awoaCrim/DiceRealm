// JSON.parse alone silently accepts repeated object keys. Preserve rejection at file boundaries.
export function parseJsonObject(text) {
  let document;
  try { document = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('文件不是合法 JSON。'); }
  if (!document || Array.isArray(document) || typeof document !== 'object') throw new Error('文档顶层必须是 JSON 对象。');
  const stack = [];
  let key = false;
  for (const token of text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) || []) {
    if (token === '{') { stack.push(new Set()); key = true; }
    else if (token === '[') { stack.push(null); key = false; }
    else if (token === '}' || token === ']') { stack.pop(); key = false; }
    else if (token === ',') key = stack.at(-1) !== null;
    else if (token === ':') key = false;
    else if (key && stack.at(-1)) {
      const value = JSON.parse(token);
      if (stack.at(-1).has(value)) throw new Error('JSON 存在重复字段：' + value);
      stack.at(-1).add(value); key = false;
    }
  }
  return document;
}
