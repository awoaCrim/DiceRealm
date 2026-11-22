// 模块引导回归：工作台入口 main.js 的静态模块图必须在实例化阶段完成解析。
// 缺失命名导出只会在 import 解析时抛错；单独渲染测试无法覆盖入口图中的每个模块，
// 因此这里按入口的静态 import 逐一声明式导入，把「整个主模块图加载失败」变成可见回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('the static module graph of the workbench entry links without missing exports', async () => {
  const entry = new URL('../src/main.js', import.meta.url);
  const source = await readFile(entry, 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s+'(\.[^']+)'/g)].map(match => match[1]);
  assert.ok(specifiers.length >= 15, 'main.js 必须静态导入工作台路由模块');
  for (const specifier of new Set(specifiers)) {
    await assert.doesNotReject(() => import(new URL(specifier, entry).href), `模块链接失败：${specifier}`);
  }
});
