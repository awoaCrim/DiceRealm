// dom.js — 无依赖 DOM 工具。绝不使用 innerHTML / 内联 style（父级 CSP: script-src 'self'; style-src 'self'）。
// 所有不可信内容一律经 textContent 进入文档。

import {attachDialogDrag} from './dialog-drag.js';

export function h(tag, attrs = {}, ...children) {
  let el;
  if (tag.includes('#') || (tag.includes('.') && !tag.includes(' '))) {
    // 支持 h3#id.clsA.clsB 简写
    const [base, ...rest] = tag.split(/(?=[#.])/);
    el = document.createElement(base || 'div');
    for (const part of rest) {
      if (part[0] === '#') el.id = part.slice(1);
      else if (part[0] === '.' && part.length > 1) el.classList.add(part.slice(1));
    }
  } else {
    el = document.createElement(tag);
  }
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className += ' ' + v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'value') el.value = String(v);
    else if (k === 'checked') el.checked = true;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  add(el, children);
  return el;
}
export function add(el, children) {
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'object' && c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

// —— 展示辅助（纯文本，安全）——
/** 首个字素（含 emoji 组合），用于印章式姓名首字。 */
export const initial = (name, fallback = '？') => {
  const text = String(name ?? '');
  const first = globalThis.Intl?.Segmenter ? [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)][0]?.segment : [...text][0];
  return first || fallback;
};
/** 叙事流右侧的时刻（HH:MM）；完整时间放在 title。 */
export const fmtClock = (iso) => { const date = iso ? new Date(iso) : null; return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : ''; };
export const fmtTime = (iso) => { const date = iso ? new Date(iso) : null; return date && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '—'; };

export function card(title, hint, ...body) {
  return h('section.card', {},
    title ? h('h3', {}, title, hint ? h('span.hint', {}, ` ${hint}`) : null) : null,
    body);
}
// Every page opens with the same head: title, optional one-line purpose, and the page's
// own actions on the right. Refreshing lives in the top bar, not in each head.
export function pageHead(title, sub, ...actions) {
  const list = actions.flat().filter(Boolean);
  return h('div.view-head', {},
    h('div.view-heading', {}, h('h1.view-title', {}, title), sub ? h('p.view-sub', {}, sub) : null),
    list.length ? h('div.view-actions', {}, list) : null);
}
export function kv(pairs) {
  return h('dl.kv', {}, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}
export function errorBox(msg) { return msg ? h('div.error-box', { role: 'alert' }, msg) : null; }

/** Hands a Blob to the browser's download; the object URL outlives slow save dialogs. */
export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob), link = h('a', { href: url, download: name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export function downloadJson(name, value) {
  downloadBlob(name, new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' }));
}

/** 退出当前显示层；不替代业务取消、放弃或停止。 */
export function closeButton(label, close) {
  return h('button.btn.btn-ghost.close-button', {
    type: 'button', 'aria-label': label, title: label, onclick: close
  }, '×');
}

/** Compact secondary action with a visible glyph and an accessible name. */
export function iconButton(label, glyph, attrs = {}) {
  return h('button.icon-button', {type:'button', 'aria-label':label, title:label, ...attrs},
    h('span', {'aria-hidden':'true'}, glyph));
}

let dialogSequence = 0;
/** 显式确认对话框（付费/破坏性操作必经）。只有确认按钮返回 true。 */
export function confirmDialog({ title, lines = [], confirmText = '确认发起', danger = false }) {
  return new Promise(resolve => {
    let accepted = false;
    const opener=document.activeElement;
    const titleId = 'workbench-modal-title-' + (++dialogSequence);
    const close = closeButton('关闭确认', () => dlg.close());
    close.setAttribute('autofocus', '');
    const dlg = h('dialog.modal', { 'aria-labelledby': titleId },
      h('div.modal-head', {}, h('h3', {id: titleId}, title), close),
      h('div.small', {}, lines.map(line => h('p', {}, line))),
      h('div.btn-row', {},
        h('button.btn.' + (danger ? 'btn-danger' : 'btn-primary'), { type: 'button', onclick: () => { accepted = true; dlg.close(); } }, confirmText)));
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => { dlg.remove(); if(opener?.isConnected)opener.focus(); resolve(accepted); }, { once: true });
    attachDialogDrag(dlg);dlg.showModal();
  });
}
