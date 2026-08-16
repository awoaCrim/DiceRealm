import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/**
 * Phase 4 真实浏览器验收场景（仅由 scripts/phase4-browser-validation.ts 通过 tsx 加载执行；
 * root vitest.config.ts 已显式 exclude 本文件，普通 `npm test` 不会在 node 环境运行它）。
 *
 * 原则：
 * - 三个隔离 context（owner / playerA / playerB），各自独立 cookie jar；
 * - 全部通过真实 UI 操作（可访问名称、表单、导航、可见文本）驱动，绝不直接写 Query Cache；
 * - 隐私断言只查用户可见文本与 DOM 缺失（不存在 ≠ 渲染为空）；
 * - fixture server（in-memory SQLite + ScriptedAiProvider）提供真实 HTTP/SSE 数据；
 * - 断连/错误注入使用 test-only 浏览器机制（route abort / route fulfill 500），
 *   不伪造服务端数据；取消注入后仍由真实服务端恢复。
 */

export interface Phase4BrowserScenarioOptions {
  /** Vite dev server（同源 /api proxy → fixture）地址，如 http://127.0.0.1:5177。 */
  frontendUrl: string;
  /** 截图输出目录（不强制纳入业务 diff）。 */
  outputDir?: string;
  /**
   * test-only：由 runner 注入，真正关闭指定 campaign/viewer 的服务端 SSE 订阅与响应，
   * 返回关闭数量（0 = 未找到匹配连接）。用于证明浏览器真实断连重连，而非 route abort
   * （已建立的 EventSource 连接不受 context.route 拦截）。
   */
  disconnectRealtime?(campaignId: string, viewer: { role: 'owner' | 'player'; playerId: string | null }): number;
  /** test-only Provider config used by the real WebUI fill/test/save flow. */
  providerConfig?: { baseUrl: string; model: string; apiKey: string };
}

export interface Phase4BrowserResult {
  ok: boolean;
  steps: string[];
  error?: string;
}

function ok(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待页面条件（Playwright 内置断言外的最小等待器）。 */
async function waitUntil(
  page: Page,
  fn: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = '';
  while (Date.now() < deadline) {
    try {
      if (await fn()) {
        return;
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`等待超时：${message}${lastReason ? `（${lastReason}）` : ''}`);
}

function ownerNav(page: Page) {
  return page.getByRole('navigation', { name: 'Owner 导航' });
}

function playerNav(page: Page) {
  return page.getByRole('navigation', { name: 'Player 导航' });
}

async function clickNav(page: Page, nav: ReturnType<typeof ownerNav>, label: string): Promise<void> {
  await nav.getByRole('link', { name: label }).click();
}

async function screenshot(page: Page, outputDir: string | undefined, name: string): Promise<void> {
  if (!outputDir) {
    return;
  }
  try {
    await page.screenshot({ path: `${outputDir}/${name}.png`, fullPage: true });
  } catch {
    // 截图失败不影响验收断言。
  }
}

export async function runPhase4BrowserScenarios(
  options: Phase4BrowserScenarioOptions,
): Promise<Phase4BrowserResult> {
  const steps: string[] = [];
  const note = (step: string) => {
    steps.push(step);
    console.log(`[phase4-browser] ${step}`);
  };

  let browser: Browser | null = null;
  const contexts: BrowserContext[] = [];

  try {
    browser = await chromium.launch({ headless: true });
    const ownerCtx = await browser.newContext();
    const playerACtx = await browser.newContext();
    const playerBCtx = await browser.newContext();
    contexts.push(ownerCtx, playerACtx, playerBCtx);

    const owner = await ownerCtx.newPage();
    const playerA = await playerACtx.newPage();
    const playerB = await playerBCtx.newPage();

    const origin = options.frontendUrl.replace(/\/$/, '');

    // ============================================================
    // 阶段 0：owner 注册 → 登录 → 创建战役 → 保存邀请链接
    // ============================================================
    note('owner register/login/create campaign');
    await owner.goto(`${origin}/register`);
    await owner.getByLabel('登录名').fill('owner1');
    await owner.getByLabel('密码', { exact: true }).fill('password-1');
    await owner.getByLabel('确认密码').fill('password-1');
    await owner.getByRole('button', { name: '注册' }).click();
    await owner.waitForURL('**/login');
    await owner.getByText('注册成功，请登录。').waitFor();
    // 注册页预填登录名
    equal(await owner.getByLabel('登录名').inputValue(), 'owner1', '注册后登录页应预填登录名');
    await owner.getByLabel('密码', { exact: true }).fill('password-1');
    await owner.getByRole('button', { name: '登录' }).click();
    await owner.waitForURL('**/campaigns');
    await owner.getByRole('heading', { name: '我的战役' }).waitFor();
    await owner.getByText('暂无战役。').waitFor();

    await owner.goto(`${origin}/campaigns/new`);
    await owner.getByLabel('战役名称').fill('烛堡之门');
    await owner.getByRole('button', { name: '创建战役' }).click();
    await owner.getByRole('heading', { name: '保存邀请码' }).waitFor();
    const inviteLink = await owner.getByLabel('邀请链接').inputValue();
    ok(inviteLink.startsWith(`${origin}/campaigns/join/`), `邀请链接应以 origin 开头：${inviteLink}`);
    const inviteCode = await owner.getByTestId('invite-code').textContent();
    ok(inviteCode && inviteCode.length > 0, '应展示一次性邀请码');
    const campaignIdMatch = /\/campaigns\/join\/([^/?]+)/.exec(inviteLink);
    ok(campaignIdMatch, '邀请链接应包含 campaignId');
    const campaignId = campaignIdMatch![1];

    await owner.getByRole('button', { name: '我已保存，进入工作区' }).click();
    await owner.waitForURL(`**/campaigns/${campaignId}/owner/turn`);
    await owner.getByRole('heading', { name: '回合与 AI 运行' }).waitFor();
    await owner.getByText('DND AI-DM · Owner').waitFor();
    await owner.getByText('烛堡之门').waitFor();
    await clickNav(owner, ownerNav(owner), 'AI 接口');
    await owner.getByRole('heading', { name: 'AI 接口', exact: true }).waitFor();
    await owner.getByText('未配置，AI 结算会安全失败').waitFor();
    const providerConfig = options.providerConfig;
    ok(providerConfig, '浏览器场景必须提供 test-only Provider 配置');
    await owner.getByLabel('API 地址').fill(providerConfig.baseUrl);
    await owner.getByLabel('模型').fill(providerConfig.model);
    await owner.getByLabel('API Key').fill(providerConfig.apiKey);
    await owner.getByRole('button', { name: '测试连接' }).click();
    await owner.getByText('连接测试成功。').waitFor();
    await owner.getByRole('button', { name: '保存并立即启用' }).click();
    await owner.getByText('配置已加密保存并立即生效。').waitFor();
    await owner.getByText('已配置，可用于 AI 结算').waitFor();
    equal(await owner.getByLabel('API Key').inputValue(), '', '保存后 API Key 输入框必须清空');
    equal(await owner.getByText(providerConfig.apiKey).count(), 0, 'API Key 不得回显到 DOM');
    await clickNav(owner, ownerNav(owner), 'AI 日志');
    await owner.getByRole('heading', { name: 'AI 日志', exact: true }).waitFor();
    await owner.getByText('暂无AI 日志。').waitFor();
    await clickNav(owner, ownerNav(owner), '回合与 AI 运行');
    await owner.getByRole('heading', { name: '回合与 AI 运行' }).waitFor();
    const ownerLayout = await owner.locator('.workspace__body').evaluate((body) => {
      const sidebar = body.querySelector<HTMLElement>('.workspace__sidebar');
      const main = body.querySelector<HTMLElement>('.workspace__main');
      const inspector = body.querySelector<HTMLElement>('.workspace__inspector');
      if (!sidebar || !main || !inspector) {
        return null;
      }
      const sidebarRect = sidebar.getBoundingClientRect();
      const mainRect = main.getBoundingClientRect();
      const inspectorRect = inspector.getBoundingClientRect();
      return {
        display: getComputedStyle(body).display,
        sidebarRight: sidebarRect.right,
        mainLeft: mainRect.left,
        mainRight: mainRect.right,
        inspectorLeft: inspectorRect.left,
      };
    });
    ok(ownerLayout !== null, 'Owner 工作区应包含 sidebar/main/inspector');
    equal(ownerLayout!.display, 'grid', 'Owner 工作区桌面布局必须使用 grid，不能退化为裸 HTML 文档流');
    ok(ownerLayout!.mainLeft >= ownerLayout!.sidebarRight, 'Owner 主内容应位于侧栏右侧');
    ok(ownerLayout!.inspectorLeft >= ownerLayout!.mainRight, 'Owner 信息栏应位于主内容右侧');
    await screenshot(owner, options.outputDir, 'phase1-owner-workspace');

    await owner.setViewportSize({ width: 720, height: 900 });
    const ownerMobileLayout = await owner.locator('.workspace__body').evaluate((body) => ({
      display: getComputedStyle(body).display,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    equal(ownerMobileLayout.display, 'block', 'Owner 工作区窄屏布局应切换为纵向文档流');
    ok(
      ownerMobileLayout.documentWidth <= ownerMobileLayout.viewportWidth,
      `Owner 工作区窄屏不应产生横向页面溢出（document=${ownerMobileLayout.documentWidth}, viewport=${ownerMobileLayout.viewportWidth}）`,
    );
    await screenshot(owner, options.outputDir, 'phase1-owner-workspace-mobile');
    await owner.setViewportSize({ width: 1280, height: 720 });

    // ============================================================
    // 阶段 1：playerA / playerB 先注册登录（独立 context），再经邀请链接加入
    // ============================================================
    note('playerA/playerB register/login then join via invite link');
    async function registerAndLogin(page: Page, loginName: string) {
      await page.goto(`${origin}/register`);
      await page.getByLabel('登录名').fill(loginName);
      await page.getByLabel('密码', { exact: true }).fill('password-1');
      await page.getByLabel('确认密码').fill('password-1');
      await page.getByRole('button', { name: '注册' }).click();
      await page.waitForURL('**/login');
      await page.getByLabel('密码', { exact: true }).fill('password-1');
      await page.getByRole('button', { name: '登录' }).click();
      await page.waitForURL('**/campaigns');
      await page.getByRole('heading', { name: '我的战役' }).waitFor();
    }

    await registerAndLogin(playerA, 'alice');
    await playerA.goto(inviteLink);
    await playerA.getByRole('heading', { name: '加入战役' }).waitFor();
    equal(await playerA.getByLabel('战役 ID').inputValue(), campaignId, '加入页应预填战役 ID');
    ok((await playerA.getByLabel('邀请码').inputValue()) === inviteCode, '加入页应预填邀请码');
    await playerA.getByRole('button', { name: '加入战役' }).click();
    await playerA.waitForURL(`**/campaigns/${campaignId}/player/story`);
    await playerA.getByRole('heading', { name: '剧情' }).waitFor();

    await registerAndLogin(playerB, 'bob');
    await playerB.goto(inviteLink);
    await playerB.getByRole('button', { name: '加入战役' }).click();
    await playerB.waitForURL(`**/campaigns/${campaignId}/player/story`);
    await playerB.getByRole('heading', { name: '剧情' }).waitFor();

    // owner 战役详情通过 player.joined 刷新：成员数 3（owner + 2 players）——非关键断言，跳过数值。
    await screenshot(playerA, options.outputDir, 'phase1-playerA-story');

    // ============================================================
    // 阶段 2：角色创建/提交与 owner 审核
    // ============================================================
    note('players create and submit characters; owner reviews');
    await clickNav(playerA, playerNav(playerA), '角色');
    await playerA.getByRole('heading', { name: '角色', exact: true }).waitFor();
    await playerA.getByRole('heading', { name: '创建角色' }).waitFor();
    await playerA.getByLabel('姓名').fill('战士甲');
    await playerA.getByLabel('AC').fill('17');
    await playerA.getByLabel('力量').fill('16');
    await playerA.getByLabel('装备（每行一件）').fill('长剑\n皮甲');
    await playerA.getByLabel('法术（每行一个）').fill('');
    await playerA.getByLabel('背景').fill('佣兵');
    await playerA.getByRole('button', { name: '保存' }).click();
    await playerA.getByRole('button', { name: '提交审核' }).click();
    await playerA.getByText('审核中，等待主持确认。').waitFor();

    await clickNav(playerB, playerNav(playerB), '角色');
    await playerB.getByRole('heading', { name: '创建角色' }).waitFor();
    await playerB.getByLabel('姓名').fill('法师乙');
    await playerB.getByLabel('AC').fill('13');
    await playerB.getByLabel('敏捷').fill('14');
    await playerB.getByLabel('背景').fill('学徒');
    await playerB.getByRole('button', { name: '保存' }).click();
    await playerB.getByRole('button', { name: '提交审核' }).click();
    await playerB.getByText('审核中，等待主持确认。').waitFor();

    // owner 审核：读 review 卡片的 title 属性拿到完整 playerId（真实 UI 可见值）。
    await clickNav(owner, ownerNav(owner), '角色审核');
    await owner.getByRole('heading', { name: '角色审核' }).waitFor();
    await owner.getByText('战士甲').waitFor();
    await owner.getByText('法师乙').waitFor();
    const reviewerSpans = owner.locator('.character-review-card span[title]');
    await waitUntil(owner, async () => (await reviewerSpans.count()) >= 2, '两张待审卡各有一个 playerId title');
    const playerIds: Record<'A' | 'B', string> = { A: '', B: '' };
    const cardA = owner.locator('.character-review-card', { hasText: '战士甲' });
    playerIds.A = (await cardA.locator('span[title]').getAttribute('title')) ?? '';
    const cardB = owner.locator('.character-review-card', { hasText: '法师乙' });
    playerIds.B = (await cardB.locator('span[title]').getAttribute('title')) ?? '';
    ok(playerIds.A.length > 0 && playerIds.B.length > 0 && playerIds.A !== playerIds.B, '两玩家 ID 应非空且不同');

    await cardA.getByRole('button', { name: '通过' }).click();
    await cardB.getByRole('button', { name: '通过' }).click();
    await owner.getByText('暂无待审角色。').waitFor();
    await owner.getByText('战士甲').waitFor();
    await owner.getByText('法师乙').waitFor();

    // player 角色页显示已批准（派生 AC）。角色变更无 SSE 事件，跨客户端同步依赖
    // refetchOnWindowFocus/刷新：这里用真实页面刷新验证设计机制。
    await playerA.reload();
    await clickNav(playerA, playerNav(playerA), '角色');
    await playerA.getByRole('heading', { name: '角色', exact: true }).waitFor();
    await playerA.getByText('已批准。').waitFor();
    await playerA.getByText(/AC（派生）：17/).waitFor();
    await playerB.reload();
    await clickNav(playerB, playerNav(playerB), '角色');
    await playerB.getByText('已批准。').waitFor();
    await screenshot(owner, options.outputDir, 'phase2-owner-characters-approved');

    // ============================================================
    // 阶段 3：开始回合、A 提交/编辑、B 最后提交自动锁定
    // ============================================================
    note('turn start / submit / edit / auto-lock');
    await clickNav(owner, ownerNav(owner), '回合与 AI 运行');
    await owner.getByRole('button', { name: '开始回合' }).click();
    await owner.getByText('第 1 回合 · 等待行动').waitFor();
    await owner.getByText('已提交 0 / 2').waitFor();

    await clickNav(playerA, playerNav(playerA), '行动');
    await playerA.getByRole('heading', { name: '行动', exact: true }).waitFor();
    const actionBodyA = playerA.getByLabel('行动内容');
    await actionBodyA.waitFor();
    ok(await actionBodyA.isEnabled(), '等待期 A 的编辑器应可用');
    await actionBodyA.fill('我点燃火把，照亮前方的密道。');
    await playerA.getByRole('button', { name: '提交行动' }).click();
    await playerA.getByText('已提交 1 / 2').waitFor();
    await playerA.getByText('已提交，可修改直到回合锁定。').waitFor();

    // A 编辑仍可用
    await actionBodyA.fill('我点燃火把，照亮前方的密道，并检查墙壁上的符文。');
    await playerA.getByRole('button', { name: '更新行动' }).click();
    await waitUntil(
      playerA,
      async () => (await actionBodyA.inputValue()) === '我点燃火把，照亮前方的密道，并检查墙壁上的符文。',
      'A 编辑后保留新正文（服务端确认）',
      10_000,
    );
    await playerA.getByText('已提交 1 / 2').waitFor();

    await clickNav(playerB, playerNav(playerB), '行动');
    const actionBodyB = playerB.getByLabel('行动内容');
    await actionBodyB.fill('我念出探测魔法的咒语。');
    await playerB.getByRole('button', { name: '提交行动' }).click();
    // B 最后提交 → 自动锁定
    await playerB.getByText('本回合已锁定。').waitFor();

    // owner 看到锁定 + 全部行动正文
    await owner.getByText('第 1 回合 · 已锁定').waitFor();
    await owner.getByText('已提交 2 / 2').waitFor();
    await owner.getByText('我点燃火把，照亮前方的密道，并检查墙壁上的符文。').waitFor();
    await owner.getByText('我念出探测魔法的咒语。').waitFor();

    // A 看到锁定且编辑器禁用
    await waitUntil(playerA, async () => (await playerA.getByText('本回合已锁定。').count()) > 0, 'A 看到回合锁定');
    ok(await actionBodyA.isDisabled(), '锁定后 A 的编辑器应禁用');
    await screenshot(playerB, options.outputDir, 'phase3-locked');

    // ============================================================
    // 阶段 4：owner 发起 AI 结算；playerA SSE 断线重连；预览与私隐隔离
    // ============================================================
    note('resolve with real SSE disconnect/reconnect on playerA');
    await clickNav(playerA, playerNav(playerA), '剧情');
    await playerA.getByRole('heading', { name: '剧情', exact: true }).waitFor();
    await clickNav(playerB, playerNav(playerB), '剧情');
    await playerB.getByRole('heading', { name: '剧情', exact: true }).waitFor();

    // 记录 playerA context 的 events 请求：真实断连后必须出现新的 ?after=N 请求。
    const playerAEventsRequests: string[] = [];
    const onPlayerARequest = (request: { url(): string }) => {
      if (request.url().includes('/events')) {
        playerAEventsRequests.push(request.url());
      }
    };
    playerACtx.on('request', onPlayerARequest);

    await clickNav(owner, ownerNav(owner), '回合与 AI 运行');
    await owner.getByRole('button', { name: '发起 AI 结算' }).click();

    // 真正关闭 playerA 的服务端 SSE 订阅与响应：已建立的 EventSource 无法用 context.route
    // abort 打断，必须由 fixture 断开服务端连接；客户端 EventSource onerror → 按 lastSeen 重连。
    const closed = options.disconnectRealtime?.(campaignId, { role: 'player', playerId: playerIds.A }) ?? 0;
    ok(closed >= 1, `应关闭 playerA 的服务端 SSE 订阅（实际关闭 ${closed}）`);

    // 等待 playerA 发起新的 events 请求且携带 after>0（客户端按 per-campaign 高水位重连）。
    await waitUntil(
      playerA,
      async () => {
        const last = playerAEventsRequests[playerAEventsRequests.length - 1];
        if (!last) {
          return false;
        }
        const after = new URL(last).searchParams.get('after');
        return after !== null && Number(after) > 0;
      },
      'playerA 断连后发起新的 events?after>0 请求',
      20_000,
    );
    note(`playerA 重连请求：${playerAEventsRequests[playerAEventsRequests.length - 1]}`);

    // playerA：重连后 preview 恰好出现一次且完整（sequence 去重证明）。
    await waitUntil(
      playerA,
      async () => {
        const texts = await playerA.locator('.preview-text').allTextContents();
        return texts.length === 1 && texts[0] === '临时生成中：前方危险！';
      },
      'playerA 重连后 preview 完整且仅一次',
      20_000,
    );
    note('playerA preview rebuilt without duplication');

    // 等待结算完成：preview 消失，entries 出现。
    await waitUntil(
      playerA,
      async () =>
        (await playerA.locator('.preview-text').count()) === 0 &&
        (await playerA.getByText('你们穿过密道，来到了烛堡深处的殿堂。').count()) > 0,
      'playerA 看到公开叙事且预览清空',
      20_000,
    );
    await waitUntil(
      playerB,
      async () => (await playerB.getByText('你们穿过密道，来到了烛堡深处的殿堂。').count()) > 0,
      'playerB 看到公开叙事',
      20_000,
    );

    // 私密隔离：positive wait 后用 waitUntil 等待缺失，避免延迟泄漏竞态。
    const privateA = `私密信息：${playerIds.A.slice(0, 8)}`;
    const privateB = `私密信息：${playerIds.B.slice(0, 8)}`;
    await playerA.getByText(privateA).waitFor();
    await playerB.getByText(privateB).waitFor();
    await waitUntil(playerA, async () => (await playerA.getByText(privateB).count()) === 0, 'playerA 不得看到 playerB 的私密结果', 5_000);
    await waitUntil(playerB, async () => (await playerB.getByText(privateA).count()) === 0, 'playerB 不得看到 playerA 的私密结果', 5_000);

    // player 页面不得出现 owner-only 内容
    for (const player of [playerA, playerB]) {
      equal(await player.getByText('AI 运行').count(), 0, 'player 不得看到 AI 运行面板');
      equal(await player.getByText('rawDebug').count(), 0, 'player 不得看到 rawDebug');
      equal(await player.getByText('owner.debug').count(), 0, 'player 不得看到 owner.debug');
    }

    // owner：下一回合已自动创建（第 1 回合 completed → 第 2 回合 waiting）
    await waitUntil(owner, async () => (await owner.getByText('第 2 回合 · 等待行动').count()) > 0, 'owner 看到第 2 回合', 20_000);
    await clickNav(owner, ownerNav(owner), 'AI 日志');
    await owner.getByRole('heading', { name: 'AI 日志', exact: true }).waitFor();
    await owner.locator('.ai-log-table td strong', { hasText: 'scripted' }).waitFor();
    const firstLogDetail = owner.getByRole('button', { name: '查看详情' }).first();
    await firstLogDetail.click();
    await owner.getByRole('heading', { name: 'context' }).waitFor();
    await screenshot(owner, options.outputDir, 'phase4-resolved');

    // ============================================================
    // 阶段 5：第二次结算前手动存档（AI 创建事实/遭遇的恢复基线）
    // ============================================================
    note('manual archive before second AI resolution');
    await clickNav(owner, ownerNav(owner), '存档');
    await owner.getByRole('heading', { name: '存档', exact: true }).waitFor();
    await owner.getByLabel('存档说明').fill('第二回合前存档');
    await owner.getByRole('button', { name: '创建存档' }).click();
    await owner.getByText('第二回合前存档').waitFor();

    // ============================================================
    // 阶段 6：turn-2 玩家行动 → 第二次 AI 结算创建世界事实与遭遇（Owner 零手工创建）
    // ============================================================
    note('turn 2 actions then second AI resolution creates world facts + encounter');
    await clickNav(playerA, playerNav(playerA), '行动');
    await playerA.getByRole('heading', { name: '行动', exact: true }).waitFor();
    const actionBodyA2 = playerA.getByLabel('行动内容');
    await actionBodyA2.waitFor();
    ok(await actionBodyA2.isEnabled(), '第 2 回合等待期 A 的编辑器应可用');
    await actionBodyA2.fill('我沿密道向前探查，寻找光源。');
    await playerA.getByRole('button', { name: '提交行动' }).click();
    await playerA.getByText('已提交 1 / 2').waitFor();

    await clickNav(playerB, playerNav(playerB), '行动');
    const actionBodyB2 = playerB.getByLabel('行动内容');
    await actionBodyB2.fill('我念出探测魔法的咒语，紧盯前方的阴影。');
    await playerB.getByRole('button', { name: '提交行动' }).click();
    await playerB.getByText('本回合已锁定。').waitFor();

    await clickNav(owner, ownerNav(owner), '回合与 AI 运行');
    await owner.getByText('第 2 回合 · 已锁定').waitFor();
    await owner.getByText('已提交 2 / 2').waitFor();
    // 玩家先回到剧情页，结算后公开叙事与私密结果才会在其视野中出现。
    await clickNav(playerA, playerNav(playerA), '剧情');
    await playerA.getByRole('heading', { name: '剧情', exact: true }).waitFor();
    await clickNav(playerB, playerNav(playerB), '剧情');
    await playerB.getByRole('heading', { name: '剧情', exact: true }).waitFor();
    await owner.getByRole('button', { name: '发起 AI 结算' }).click();
    await waitUntil(playerA, async () => (await playerA.getByText('密道深处传来低沉的吼声，伏击一触即发。').count()) > 0, 'playerA 看到第二次结算公开叙事', 20_000);
    await waitUntil(playerB, async () => (await playerB.getByText('密道深处传来低沉的吼声，伏击一触即发。').count()) > 0, 'playerB 看到第二次结算公开叙事', 20_000);
    await waitUntil(owner, async () => (await owner.getByText('第 3 回合 · 等待行动').count()) > 0, 'owner 看到第 3 回合', 20_000);
    await screenshot(owner, options.outputDir, 'phase5-second-resolution');

    // ============================================================
    // 阶段 7：AI 创建的世界事实与遭遇（owner 全量监督；player 只读投影）
    // ============================================================
    note('AI-created world facts and encounter visible to owner, projected to players');
    await clickNav(owner, ownerNav(owner), '世界');
    await owner.getByRole('heading', { name: '世界状态' }).waitFor();
    await owner.getByRole('heading', { name: '烛堡密道' }).waitFor();
    await owner.getByRole('heading', { name: '影印暗记' }).waitFor();
    await owner.getByRole('heading', { name: '地宫主人' }).waitFor();
    // owner 全量可见三种可见性徽章。
    await owner.getByText('所有玩家可见').waitFor();
    await owner.getByText('指定玩家可见').waitFor();
    await owner.getByText('仅 AI-DM / Owner 可见').waitFor();
    // Owner 世界页无任何创建/编辑表单。
    equal(await owner.getByRole('button', { name: '创建事实' }).count(), 0, 'Owner 世界页不得有创建表单');

    await clickNav(owner, ownerNav(owner), '战斗');
    await owner.getByRole('heading', { name: '战斗状态' }).waitFor();
    await owner.getByRole('heading', { name: '密道伏击' }).waitFor();
    // AI 发起且 rollInitiative=true：遭遇 active、全员先攻已掷。
    await waitUntil(owner, async () => {
      const texts = await owner.locator('.combatant-summary').allTextContents();
      return texts.length === 3 && texts.every((t) => t.includes('先攻')) && (await owner.getByText('当前行动').count()) > 0;
    }, 'owner 看到三个战斗员且先攻已掷、有当前行动者', 15_000);
    await owner.getByText('哥布林斥候').waitFor();
    await owner.getByText('影缚刺客').waitFor();
    await owner.getByText('地宫支配者').waitFor();
    // Owner 战斗页无任何手工命令/创建表单。
    equal(await owner.getByRole('button', { name: '开始战斗' }).count(), 0, 'Owner 战斗页不得有创建表单');

    await clickNav(playerA, playerNav(playerA), '战斗');
    await playerA.getByRole('heading', { name: '战斗', exact: true }).waitFor();
    await waitUntil(playerA, async () => (await playerA.getByText('密道伏击').count()) > 0, 'playerA 看到 AI 遭遇', 20_000);
    await playerA.getByText('哥布林斥候').waitFor();
    await playerA.getByText('影缚刺客').waitFor();
    equal(await playerA.getByText('地宫支配者').count(), 0, 'playerA 不得看到 owner_only 战斗员');

    await clickNav(playerB, playerNav(playerB), '战斗');
    await playerB.getByRole('heading', { name: '战斗', exact: true }).waitFor();
    await waitUntil(playerB, async () => (await playerB.getByText('密道伏击').count()) > 0, 'playerB 看到 AI 遭遇', 20_000);
    await playerB.getByText('哥布林斥候').waitFor();
    equal(await playerB.getByText('影缚刺客').count(), 0, 'playerB 不得看到 playerA 专属战斗员');
    equal(await playerB.getByText('地宫支配者').count(), 0, 'playerB 不得看到 owner_only 战斗员');
    await screenshot(playerA, options.outputDir, 'phase5-playerA-ai-combat');

    // ============================================================
    // 阶段 8：恢复手动存档 → AI 创建的事实与遭遇被移除
    // ============================================================
    note('restore manual archive removes AI-created facts and encounter');
    await clickNav(owner, ownerNav(owner), '存档');
    await owner.getByRole('heading', { name: '存档', exact: true }).waitFor();
    await owner.once('dialog', (dialog) => dialog.accept());
    const restoreRow = owner.locator('.archive-row', { hasText: '第二回合前存档' });
    await restoreRow.getByRole('button', { name: '恢复' }).click();
    // 恢复后 AI 创建的世界事实被回滚（快照外事实 supersede）。
    await clickNav(owner, ownerNav(owner), '世界');
    await waitUntil(owner, async () => (await owner.getByText('世界尚未展开').count()) > 0, '恢复后世界事实被回滚', 20_000);
    equal(await owner.getByText('烛堡密道').count(), 0, '恢复后烛堡密道不存在');
    equal(await owner.getByText('影印暗记').count(), 0, '恢复后影印暗记不存在');
    equal(await owner.getByText('地宫主人').count(), 0, '恢复后地宫主人不存在');
    // 恢复后 AI 创建的遭遇被回滚。
    await clickNav(owner, ownerNav(owner), '战斗');
    await waitUntil(owner, async () => (await owner.getByText('当前没有遭遇').count()) > 0, '恢复后遭遇被回滚', 20_000);
    equal(await owner.getByText('密道伏击').count(), 0, '恢复后密道伏击不存在');
    await screenshot(owner, options.outputDir, 'phase6-restored');

    // ============================================================
    // 阶段 9：单 feature 请求失败，工作区 shell 与其它 panel 不受影响
    // ============================================================
    note('feature error boundary');
    // 当前页是战斗；先离开，确保随后重新进入会真实发起 feature query，
    // 而不是命中仍为 fresh 的 Query Cache。
    await clickNav(owner, ownerNav(owner), '回合与 AI 运行');
    await owner.getByRole('heading', { name: '回合与 AI 运行' }).waitFor();
    await ownerCtx.route('**/api/campaigns/*/world', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '测试注入失败。' } }),
      }),
    );
    await clickNav(owner, ownerNav(owner), '世界');
    await owner.getByText('世界事实加载失败。').waitFor();
    // shell 仍完整：header + 导航 + 其它页面可用
    await owner.getByText('DND AI-DM · Owner').waitFor();
    await ownerNav(owner).getByRole('link', { name: '角色审核' }).waitFor();
    await clickNav(owner, ownerNav(owner), '战斗');
    await owner.getByRole('heading', { name: '战斗状态' }).waitFor();
    // 取消注入后重新进入；TanStack Query 可能自动 refetch，也可能保留 error
    // 直到用户点重试，两种都属于真实可恢复路径。
    await ownerCtx.unroute('**/api/campaigns/*/world');
    await clickNav(owner, ownerNav(owner), '世界');
    const retry = owner.getByRole('button', { name: '重试' });
    if (await retry.isVisible().catch(() => false)) {
      await retry.click();
    }
    await owner.getByRole('heading', { name: '当前世界' }).waitFor();
    await screenshot(owner, options.outputDir, 'phase7-error-recovery');

    // ============================================================
    // 阶段 10：刷新保持会话；登出后受保护路由回登录
    // ============================================================
    note('session refresh and logout');
    await owner.reload();
    await owner.getByText('DND AI-DM · Owner').waitFor();
    await owner.getByRole('heading', { name: '世界状态' }).waitFor();
    await owner.getByRole('button', { name: '退出登录' }).click();
    await owner.waitForURL('**/login');
    await owner.getByRole('heading', { name: '登录' }).waitFor();
    // 未登录访问受保护路由 → 回登录
    await owner.goto(`${origin}/campaigns`);
    await owner.waitForURL((url) => url.pathname === '/login');
    await screenshot(owner, options.outputDir, 'phase8-logout');

    // ============================================================
    // Phase 1 场景：legacy URL → NotFoundPage，不发任何 legacy 请求
    // ============================================================
    note('phase1 legacy URLs resolve to NotFound without legacy requests');
    const legacyViolations: string[] = [];
    const watchLegacyRequests = (page: Page) => {
      page.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        const isLegacy =
          pathname === '/api/admin'
          || pathname.startsWith('/api/admin/')
          || pathname === '/api/player'
          || pathname.startsWith('/api/player/')
          || pathname === '/events'
          || pathname.startsWith('/events/');
        if (isLegacy) {
          legacyViolations.push(`${page === owner ? 'owner' : 'playerA'} requested ${request.url()}`);
        }
      });
    };
    watchLegacyRequests(owner); // owner 此时已登出（guest session）
    watchLegacyRequests(playerA); // playerA 仍是 logged-in session

    // guest session：两个 legacy URL 都显示 NotFound 且不跳登录。
    for (const legacyPath of ['/admin/room-1', '/player/token-1']) {
      await owner.goto(`${origin}${legacyPath}`);
      await owner.waitForURL((url) => url.pathname === legacyPath);
      await owner.getByRole('heading', { name: '页面不存在' }).waitFor();
      ok(!(await owner.getByText('旧入口迁移提示').isVisible().catch(() => false)), `${legacyPath} 不得显示迁移提示`);
    }

    // logged-in session：行为一致，且不 redirect 到 /login 或 /campaigns。
    for (const legacyPath of ['/admin/room-1', '/player/token-1']) {
      await playerA.goto(`${origin}${legacyPath}`);
      await playerA.waitForURL((url) => url.pathname === legacyPath);
      await playerA.getByRole('heading', { name: '页面不存在' }).waitFor();
    }

    // sanity：guest / → /login；logged-in / → /campaigns。
    await owner.goto(`${origin}/`);
    await owner.waitForURL((url) => url.pathname === '/login');
    await playerA.goto(`${origin}/`);
    await playerA.waitForURL((url) => url.pathname === '/campaigns');

    // 关键断言：上述导航期间不得产生任何 /api/admin、/api/player、/events 请求
    //（pathname exact/prefix 匹配，绝不使用 includes('/events')，避免误报平台 SSE）。
    ok(legacyViolations.length === 0, `legacy URL 导航不应产生 legacy API 请求：${legacyViolations.join('; ')}`);
    await screenshot(owner, options.outputDir, 'phase1-legacy-404');

    note('all browser scenarios passed');
    return { ok: true, steps };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[phase4-browser] FAILED: ${message}`);
    // 尽力截图失败现场
    if (options.outputDir && contexts[0]) {
      const pages = contexts[0].pages();
      if (pages[0]) {
        try {
          await pages[0].screenshot({ path: `${options.outputDir}/failure-owner.png`, fullPage: true });
        } catch {
          // ignore
        }
      }
    }
    return { ok: false, steps, error: message };
  } finally {
    for (const ctx of contexts) {
      await ctx.close().catch(() => undefined);
    }
    await browser?.close().catch(() => undefined);
  }
}
