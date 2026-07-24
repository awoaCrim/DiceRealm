(function (global) {
  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  var BASE = {
    rooms: [
      {
        id: 'demo',
        name: '迷雾港试玩',
        currentTurn: 3,
        status: 'waiting_for_actions',
        playerCount: 3,
        expectedPlayerCount: 4,
        createdAt: '2026-07-20T10:00:00.000Z',
        adminTokenHint: 'demo'
      }
    ],
    players: [
      { id: 'pl1', token: 'p1', name: '艾拉', roomId: 'demo' },
      { id: 'pl2', token: 'p2', name: '波林', roomId: 'demo' },
      { id: 'pl3', token: 'p3', name: '待审新兵', roomId: 'demo' }
    ],
    characters: [
      {
        id: 'ch1',
        playerId: 'pl1',
        name: '艾拉·风行',
        race: '精灵',
        className: '游侠',
        level: 3,
        background: '外乡人',
        confirmed: true,
        reviewStatus: 'approved',
        reviewComment: '',
        abilities: { str: 12, dex: 16, con: 14, int: 10, wis: 14, cha: 11 },
        skills: ['察觉', '求生', '隐匿'],
        hp: { current: 24, max: 28 },
        spellSlots: { '1': { current: 3, max: 3 } }
      },
      {
        id: 'ch2',
        playerId: 'pl2',
        name: '波林·石盾',
        race: '矮人',
        className: '战士',
        level: 3,
        background: '士兵',
        confirmed: true,
        reviewStatus: 'approved',
        reviewComment: '',
        abilities: { str: 16, dex: 12, con: 15, int: 8, wis: 11, cha: 10 },
        skills: ['运动', '威吓'],
        hp: { current: 32, max: 32 },
        spellSlots: {}
      },
      {
        id: 'ch3',
        playerId: 'pl3',
        name: '无名学徒',
        race: '人类',
        className: '法师',
        level: 1,
        background: '学者',
        confirmed: false,
        reviewStatus: 'pending_review',
        reviewComment: '',
        abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 13, cha: 10 },
        skills: ['奥秘', '历史'],
        hp: { current: 8, max: 8 },
        spellSlots: { '1': { current: 2, max: 2 } }
      }
    ],
    logs: {
      public: [
        { id: 'lg1', createdAt: '2026-07-20T10:05:00.000Z', speaker: 'DM', content: '海雾吞没了码头的灯火。远处传来锚链拖地的声响。' },
        { id: 'lg2', createdAt: '2026-07-20T10:06:00.000Z', speaker: '艾拉', content: '我压低帽檐，沿着货箱阴影靠近那艘无旗双桅船。' }
      ],
      private: [
        { id: 'lg3', createdAt: '2026-07-20T10:07:00.000Z', speaker: '系统', content: '你注意到甲板上有新鲜的血迹，尚未干透。' }
      ],
      objective: [
        { id: 'lg4', createdAt: '2026-07-20T10:05:00.000Z', speaker: '系统', content: '回合 3 开始。房间状态：等待行动。' }
      ]
    },
    pendingInteractions: [
      {
        id: 'ix1',
        playerId: 'pl1',
        prompt: '哨兵回头张望——你是立刻隐入雾中，还是假装醉汉走过？',
        response: ''
      }
    ],
    currentActions: {
      pl1: { actionType: 'in_character_action', text: '沿货箱阴影接近无旗船' },
      pl2: null
    },
    combat: {
      active: true,
      units: [
        { id: 'u1', name: '艾拉', initiative: 18, status: 'healthy' },
        { id: 'u2', name: '码头打手', initiative: 12, status: 'injured' },
        { id: 'u3', name: '波林', initiative: 9, status: 'healthy' }
      ]
    },
    diceLogs: [
      { id: 'd1', createdAt: '2026-07-20T10:08:00.000Z', actor: '艾拉', expression: '1d20+5', result: 17, note: '隐匿' },
      { id: 'd2', createdAt: '2026-07-20T10:09:00.000Z', actor: 'DM', expression: '1d20+2', result: 9, note: '察觉' }
    ],
    backpack: {
      pl1: {
        currency: { gp: 42, sp: 8, cp: 15 },
        items: [
          { id: 'it1', name: '短弓', qty: 1, note: '已 equip' },
          { id: 'it2', name: '治疗药水', qty: 2, note: '标准' },
          { id: 'it3', name: '绳索 50 尺', qty: 1, note: '' }
        ]
      }
    },
    dmMessages: {
      pl1: [
        { id: 'm1', role: 'assistant', content: '需要我帮你回顾本回合可选动作，或解释某个规则吗？' }
      ]
    },
    campaignRecords: [
      { id: 'cr1', category: 'world', title: '迷雾港', summary: '终年被海雾笼罩的自由贸易港。', visibility: 'public', updatedAt: '2026-07-18' },
      { id: 'cr2', category: 'npc', title: '老舵手哈姆', summary: '知情但要价不菲的码头老人。', visibility: 'dm', updatedAt: '2026-07-19' },
      { id: 'cr3', category: 'quest', title: '无旗船的货物', summary: '查明双桅船夜间卸货的真相。', visibility: 'party', updatedAt: '2026-07-20' }
    ],
    worldBook: [
      { id: 'wb1', name: '海雾词条', content: '夜间能见度极低，远程攻击劣势。' }
    ],
    dataSources: [
      { id: 'ds1', name: '本地 PHB 摘要', type: 'file', status: 'ready' }
    ],
    aiHost: {
      styleNotes: '偏黑暗奇幻，节奏紧凑，少用陈词滥调。',
      runtime: { temperature: 0.8, maxTokens: 2048, sceneType: 'exploration' },
      presetBlocks: [
        { id: 'pb1', role: 'system', title: 'DM 核心', content: '你是严谨的 D&D 5e 地下城主……' },
        { id: 'pb2', role: 'user', title: '场景上下文', content: '（由运行时注入）' }
      ],
      promptPreview: '【system】你是严谨的 D&D 5e 地下城主……\n【user】当前场景：迷雾港码头……'
    },
    aiLogs: [
      {
        id: 'al1',
        createdAt: '2026-07-20T10:10:00.000Z',
        source: 'mainDM',
        model: 'mock-model',
        status: 'ok',
        messages: '[{"role":"system","content":"..."}]',
        response: '{"narrative":"海雾更浓了。"}'
      },
      {
        id: 'al2',
        createdAt: '2026-07-20T10:12:00.000Z',
        source: 'dmAssistant',
        model: 'mock-model',
        status: 'ok',
        messages: '[{"role":"user","content":"隐匿怎么检定？"}]',
        response: '使用敏捷（隐匿），对抗被动察觉。'
      }
    ],
    pipelineRuns: [
      { id: 'pr1', turn: 3, stage: 'narrative', status: 'done' },
      { id: 'pr2', turn: 3, stage: 'apply', status: 'pending' }
    ],
    settings: {
      aiProvider: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-mock', model: 'gpt-mock', enabled: true },
      embeddingProvider: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-mock', model: 'embed-mock', enabled: false }
    },
    waitingPlayers: ['波林'],
    aiTurn: {
      message: '',
      promptDraft: '请根据玩家行动推进码头潜入场景。',
      resultSummary: '（尚未生成）',
      rollbackTurns: [1, 2, 3]
    }
  };

  global.UI_MOCK = {
    BASE: BASE,
    createInitialState: function () {
      return deepClone(BASE);
    }
  };
})(window);
