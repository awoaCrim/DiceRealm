import { describe, expect, it } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { defaultListen } from './startPlatformServer.js';

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('defaultListen (production HTTP listener seam, real Node server)', () => {
  it('stopAccepting blocks new connections while a held request persists; destroyConnections closes it and resolves', async () => {
    const app = express();
    let received = false;
    app.get('/hold', (_req, _res) => {
      received = true; // 永不响应：保持连接打开。
    });
    const port = await findFreePort();
    const listener = await defaultListen(app, port, '127.0.0.1');
    try {
      // 1) 建立保持打开的请求连接（raw socket，避免 fetch 连接池干扰）。
      const held = net.connect(port, '127.0.0.1');
      await new Promise<void>((resolve) => held.once('connect', () => resolve()));
      held.write('GET /hold HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
      await waitFor(() => received);

      // 2) stopAccepting：现有连接保持，新连接被拒。
      await listener.stopAccepting();
      const newConnectionAccepted = await new Promise<boolean>((resolve) => {
        const probe = net.connect(port, '127.0.0.1');
        let done = false;
        const finish = (accepted: boolean) => {
          if (done) return;
          done = true;
          probe.destroy();
          resolve(accepted);
        };
        probe.once('error', () => finish(false));
        probe.once('connect', () => finish(true));
        setTimeout(() => finish(false), 2000);
      });
      expect(newConnectionAccepted).toBe(false);
      expect(held.destroyed).toBe(false);

      // 3) destroyConnections：强制关闭保持连接并等待 server 'close' 完成。
      const heldClosed = new Promise<void>((resolve) => held.once('close', () => resolve()));
      await listener.destroyConnections();
      await heldClosed;
      expect(held.destroyed).toBe(true);

      // 4) 成功监听后不再保留 pre-listening error handler（post-listen 错误不得被 settled promise 吞掉）。
      expect(listener.server?.listenerCount('error')).toBe(0);
    } finally {
      await listener.destroyConnections().catch(() => undefined);
    }
  });
});
