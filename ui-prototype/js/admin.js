(function () {
  var C = window.UI_COMMON;
  var state = window.UI_MOCK.createInitialState();
  var roomId = C.getQuery().room || 'demo';
  var room = state.rooms.find(function (r) { return r.id === roomId; }) || null;

  if (!room) {
    C.showMessage('admin-message', '无效的房间 ID：' + roomId, true);
    return;
  }

  var playLogMode = 'objective';
  var selectedCampaignId = null;
  var selectedAsideCharacterId = null;

  function roomPlayers() {
    return (state.players || []).filter(function (p) { return p.roomId === roomId; });
  }

  function roomCharacters() {
    var playerIds = {};
    roomPlayers().forEach(function (p) { playerIds[p.id] = true; });
    return (state.characters || []).filter(function (c) { return playerIds[c.playerId]; });
  }

  function playerById(id) {
    return (state.players || []).find(function (p) { return p.id === id; }) || null;
  }

  function categoryLabel(cat) {
    var map = {
      world: '世界设定',
      npc: 'NPC',
      location: '地点',
      quest: '任务',
      summary: '纪要',
      source: '数据源'
    };
    return map[cat] || cat || '未分类';
  }

  function reviewStatusLabel(status) {
    var map = {
      approved: '已通过',
      pending_review: '待审核',
      rejected: '已拒绝',
      draft: '草稿'
    };
    return map[status] || status || '未知';
  }

  C.bindTabs(
    [
      { id: 'play', buttonId: 'tab-play', panelId: 'panel-play' },
      { id: 'campaign', buttonId: 'tab-campaign', panelId: 'panel-campaign' },
      { id: 'aihost', buttonId: 'tab-aihost', panelId: 'panel-aihost' },
      { id: 'ailog', buttonId: 'tab-ailog', panelId: 'panel-ailog' },
      { id: 'settings', buttonId: 'tab-settings', panelId: 'panel-settings' }
    ],
    { useHash: true, defaultId: 'play' }
  );

  C.bindTabs(
    [
      { id: 'records', buttonId: 'subtab-records', panelId: 'campaign-sub-records' },
      { id: 'sources', buttonId: 'subtab-sources', panelId: 'campaign-sub-sources' },
      { id: 'worldbook', buttonId: 'subtab-worldbook', panelId: 'campaign-sub-worldbook' }
    ],
    { defaultId: 'records' }
  );

  C.bindTabs(
    [
      { id: 'style', buttonId: 'aihost-sub-style', panelId: 'aihost-panel-style' },
      { id: 'debug', buttonId: 'aihost-sub-debug', panelId: 'aihost-panel-debug' },
      { id: 'assistant', buttonId: 'aihost-sub-assistant', panelId: 'aihost-panel-assistant' }
    ],
    { defaultId: 'style' }
  );

  C.bindTabs(
    [
      { id: 'players', buttonId: 'aside-tab-players', panelId: 'aside-panel-players' },
      { id: 'characters', buttonId: 'aside-tab-characters', panelId: 'aside-panel-characters' },
      { id: 'combat', buttonId: 'aside-tab-combat', panelId: 'aside-panel-combat' },
      { id: 'dice', buttonId: 'aside-tab-dice', panelId: 'aside-panel-dice' }
    ],
    { defaultId: 'players' }
  );

  function renderTopbar() {
    var parts = [room.name];
    parts.push('第 ' + room.currentTurn + ' 回合');
    parts.push(C.roomStatusLabel(room.status));
    parts.push('玩家 ' + roomPlayers().length + '/' + (room.expectedPlayerCount || '?'));
    C.setText('admin-topbar-meta', parts.join(' · '));
  }

  function renderPlayStatus() {
    var waiting = state.waitingPlayers || [];
    var html = '';
    html += '<p><strong>' + C.escapeHtml(room.name) + '</strong></p>';
    html += '<p>第 ' + room.currentTurn + ' 回合 · ' + C.escapeHtml(C.roomStatusLabel(room.status)) + '</p>';
    html += '<p>玩家 ' + roomPlayers().length + '/' + (room.expectedPlayerCount || '未设置') + '</p>';
    if (waiting.length) {
      html += '<p>等待行动：' + C.escapeHtml(waiting.join('、')) + '</p>';
    } else {
      html += '<p>等待行动：无</p>';
    }
    C.setHtml('play-status', html);

    var expectedEl = C.$('expected-count');
    if (expectedEl && document.activeElement !== expectedEl) {
      expectedEl.value = room.expectedPlayerCount != null ? room.expectedPlayerCount : '';
    }
  }

  function renderPlayPlayers() {
    var players = roomPlayers();
    var html = '';
    if (!players.length) {
      html = '<p>暂无玩家。</p>';
    } else {
      html = '<ul>';
      players.forEach(function (p) {
        html += '<li>';
        html += '<strong>' + C.escapeHtml(p.name) + '</strong>';
        html += ' · <a href="player.html?token=' + encodeURIComponent(p.token) + '">进入</a>';
        html += ' · token ' + C.escapeHtml(p.token);
        html += ' · <button type="button" data-skip-player="' + C.escapeHtml(p.id) + '">跳过</button>';
        html += '</li>';
      });
      html += '</ul>';
    }
    C.setHtml('play-players', html);
  }

  function renderPlayReviews() {
    var pending = roomCharacters().filter(function (c) {
      return c.reviewStatus === 'pending_review';
    });
    var html = '';
    if (!pending.length) {
      html = '<p>暂无待审核角色。</p>';
    } else {
      pending.forEach(function (c) {
        var owner = playerById(c.playerId);
        html += '<div data-review-id="' + C.escapeHtml(c.id) + '">';
        html += '<p><strong>' + C.escapeHtml(c.name) + '</strong>';
        html += ' · ' + C.escapeHtml(c.race || '') + ' · ' + C.escapeHtml(c.className || '');
        html += ' · 玩家 ' + C.escapeHtml(owner ? owner.name : c.playerId) + '</p>';
        html += '<p>';
        html += '<button type="button" data-approve="' + C.escapeHtml(c.id) + '">通过</button> ';
        html += '<button type="button" data-reject="' + C.escapeHtml(c.id) + '">拒绝</button>';
        html += '</p>';
        html += '</div>';
      });
    }
    C.setHtml('play-reviews', html);
  }

  function renderPlayLogs() {
    var objectiveBtn = C.$('play-log-objective');
    var publicBtn = C.$('play-log-public');
    var playerBtn = C.$('play-log-player');
    if (objectiveBtn) objectiveBtn.setAttribute('aria-selected', playLogMode === 'objective' ? 'true' : 'false');
    if (publicBtn) publicBtn.setAttribute('aria-selected', playLogMode === 'public' ? 'true' : 'false');
    if (playerBtn) playerBtn.setAttribute('aria-selected', playLogMode === 'player' ? 'true' : 'false');

    var html = '';
    if (playLogMode === 'player') {
      var players = roomPlayers();
      if (!players.length) {
        html = '<p>暂无玩家日志。</p>';
      } else {
        players.forEach(function (p) {
          html += '<h4>' + C.escapeHtml(p.name) + '</h4>';
          var privateLogs = (state.logs && state.logs.private) || [];
          var publicLogs = (state.logs && state.logs.public) || [];
          var related = publicLogs.concat(privateLogs).filter(function (log) {
            return log.speaker === p.name || (log.content && log.content.indexOf(p.name) !== -1);
          });
          if (!related.length) {
            html += '<p>暂无相关日志。</p>';
          } else {
            html += '<ul>';
            related.forEach(function (log) {
              html += '<li>';
              html += '<p><strong>' + C.escapeHtml(log.speaker || '') + '</strong>';
              html += ' · ' + C.escapeHtml(C.formatTime(log.createdAt)) + '</p>';
              html += '<p>' + C.escapeHtml(log.content || '') + '</p>';
              html += '</li>';
            });
            html += '</ul>';
          }
        });
      }
    } else {
      var logs = (state.logs && state.logs[playLogMode]) || [];
      if (!logs.length) {
        html = '<p>暂无日志。</p>';
      } else {
        html = '<ul>';
        logs.forEach(function (log) {
          html += '<li>';
          html += '<p><strong>' + C.escapeHtml(log.speaker || '') + '</strong>';
          html += ' · ' + C.escapeHtml(C.formatTime(log.createdAt)) + '</p>';
          html += '<p>' + C.escapeHtml(log.content || '') + '</p>';
          html += '</li>';
        });
        html += '</ul>';
      }
    }
    C.setHtml('play-log-list', html);
  }

  function renderAiTurn() {
    var ai = state.aiTurn || {};
    C.setText('ai-message', ai.message || '');
    C.setHtml('ai-result', '<p>' + C.escapeHtml(ai.resultSummary || '（尚未生成）') + '</p>');

    var pre = C.$('ai-prompt-pre');
    if (pre) {
      var draftEl = C.$('ai-prompt-draft');
      pre.textContent = draftEl ? draftEl.value : (ai.promptDraft || '');
    }

    var select = C.$('rollback-select');
    if (select) {
      var turns = ai.rollbackTurns || [];
      var current = select.value;
      var opts = '';
      turns.forEach(function (t) {
        opts += '<option value="' + C.escapeHtml(String(t)) + '">第 ' + C.escapeHtml(String(t)) + ' 回合</option>';
      });
      select.innerHTML = opts || '<option value="">无</option>';
      if (current && turns.map(String).indexOf(String(current)) !== -1) {
        select.value = current;
      }
    }
  }

  function filteredCampaignRecords() {
    var qEl = C.$('campaign-search');
    var catEl = C.$('campaign-category');
    var q = qEl ? qEl.value.trim().toLowerCase() : '';
    var cat = catEl ? catEl.value : 'all';
    return (state.campaignRecords || []).filter(function (rec) {
      if (cat && cat !== 'all' && rec.category !== cat) return false;
      if (!q) return true;
      var hay = ((rec.title || '') + ' ' + (rec.summary || '')).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function renderCampaignList() {
    var list = filteredCampaignRecords();
    var html = '';
    if (!list.length) {
      html = '<p>无匹配记录。</p>';
    } else {
      html = '<ul>';
      list.forEach(function (rec) {
        var active = selectedCampaignId === rec.id ? ' data-active="1"' : '';
        html += '<li>';
        html += '<button type="button" data-campaign-id="' + C.escapeHtml(rec.id) + '"' + active + '>';
        html += C.escapeHtml(rec.title || '(无标题)');
        html += ' · ' + C.escapeHtml(categoryLabel(rec.category));
        html += '</button>';
        html += '</li>';
      });
      html += '</ul>';
    }
    C.setHtml('campaign-list', html);
  }

  function renderCampaignDetail() {
    var rec = (state.campaignRecords || []).find(function (r) { return r.id === selectedCampaignId; });
    var html = '';
    if (!rec) {
      html = '<p>选择一条记录查看详情。</p>';
    } else {
      html += '<p><strong>' + C.escapeHtml(rec.title || '') + '</strong></p>';
      html += '<p>分类：' + C.escapeHtml(categoryLabel(rec.category)) + '</p>';
      html += '<p>可见性：' + C.escapeHtml(rec.visibility || '-') + '</p>';
      html += '<p>更新：' + C.escapeHtml(rec.updatedAt || '-') + '</p>';
      html += '<p>' + C.escapeHtml(rec.summary || '') + '</p>';
    }
    C.setHtml('campaign-detail', html);
  }

  function renderDataSources() {
    var list = state.dataSources || [];
    var html = '';
    if (!list.length) {
      html = '<p>暂无数据源。</p>';
    } else {
      html = '<ul>';
      list.forEach(function (ds) {
        html += '<li>';
        html += '<strong>' + C.escapeHtml(ds.name || '') + '</strong>';
        html += ' · ' + C.escapeHtml(ds.type || '');
        html += ' · ' + C.escapeHtml(ds.status || '');
        html += '</li>';
      });
      html += '</ul>';
    }
    C.setHtml('data-sources-list', html);
  }

  function renderWorldBook() {
    var list = state.worldBook || [];
    var html = '';
    if (!list.length) {
      html = '<p>暂无世界书条目。</p>';
    } else {
      html = '<ul>';
      list.forEach(function (wb) {
        html += '<li>';
        html += '<p><strong>' + C.escapeHtml(wb.name || '') + '</strong></p>';
        html += '<p>' + C.escapeHtml(wb.content || '') + '</p>';
        html += '</li>';
      });
      html += '</ul>';
    }
    C.setHtml('worldbook-list', html);
  }

  function renderAiHostDebug() {
    var host = state.aiHost || {};
    var blocks = host.presetBlocks || [];
    var html = '';
    if (!blocks.length) {
      html = '<p>暂无预设块。</p>';
    } else {
      html = '<ul>';
      blocks.forEach(function (b) {
        html += '<li>';
        html += '<p><strong>' + C.escapeHtml(b.title || '') + '</strong>';
        html += ' · ' + C.escapeHtml(b.role || '') + '</p>';
        html += '<pre>' + C.escapeHtml(b.content || '') + '</pre>';
        html += '</li>';
      });
      html += '</ul>';
    }
    C.setHtml('preset-blocks', html);

    var preview = C.$('prompt-preview');
    if (preview) preview.textContent = host.promptPreview || '';
  }

  function renderAiLogs() {
    var logs = state.aiLogs || [];
    var html = '';
    if (!logs.length) {
      html = '<p>暂无 AI 日志。</p>';
    } else {
      html = '<table><thead><tr>';
      html += '<th>时间</th><th>来源</th><th>模型</th><th>状态</th><th>详情</th>';
      html += '</tr></thead><tbody>';
      logs.forEach(function (log) {
        html += '<tr>';
        html += '<td>' + C.escapeHtml(C.formatTime(log.createdAt)) + '</td>';
        html += '<td>' + C.escapeHtml(log.source || '') + '</td>';
        html += '<td>' + C.escapeHtml(log.model || '') + '</td>';
        html += '<td>' + C.escapeHtml(log.status || '') + '</td>';
        html += '<td><details><summary>展开</summary>';
        html += '<p><strong>messages</strong></p><pre>' + C.escapeHtml(log.messages || '') + '</pre>';
        html += '<p><strong>response</strong></p><pre>' + C.escapeHtml(log.response || '') + '</pre>';
        html += '</details></td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
    }
    C.setHtml('ai-log-table', html);
  }

  function renderPipeline() {
    var runs = state.pipelineRuns || [];
    var html = '';
    if (!runs.length) {
      html = '<p>暂无流水线记录。</p>';
    } else {
      html = '<ul>';
      runs.forEach(function (run) {
        html += '<li>';
        html += '回合 ' + C.escapeHtml(String(run.turn != null ? run.turn : '-'));
        html += ' · ' + C.escapeHtml(run.stage || '');
        html += ' · ' + C.escapeHtml(run.status || '');
        html += '</li>';
      });
      html += '</ul>';
    }
    C.setHtml('pipeline-list', html);
  }

  function renderAsidePlayers() {
    var players = roomPlayers();
    var html = '';
    if (!players.length) {
      html = '<p>暂无玩家。</p>';
    } else {
      html = '<ul>';
      players.forEach(function (p) {
        html += '<li>';
        html += C.escapeHtml(p.name);
        html += ' · <a href="player.html?token=' + encodeURIComponent(p.token) + '">进入</a>';
        html += '</li>';
      });
      html += '</ul>';
    }
    C.setHtml('aside-panel-players', html);
  }

  function renderAsideCharacters() {
    var chars = roomCharacters();
    var html = '';
    if (!chars.length) {
      html = '<p>暂无角色。</p>';
    } else {
      html = '<ul>';
      chars.forEach(function (c) {
        html += '<li>';
        html += '<button type="button" data-aside-char="' + C.escapeHtml(c.id) + '">';
        html += C.escapeHtml(c.name || '');
        html += '</button>';
        html += ' · ' + C.escapeHtml(reviewStatusLabel(c.reviewStatus));
        html += '</li>';
      });
      html += '</ul>';
    }

    var selected = chars.find(function (c) { return c.id === selectedAsideCharacterId; });
    if (selected) {
      var ab = selected.abilities || {};
      html += '<hr />';
      html += '<p><strong>' + C.escapeHtml(selected.name) + '</strong></p>';
      html += '<p>' + C.escapeHtml(selected.race || '') + ' · ' + C.escapeHtml(selected.className || '');
      html += ' · Lv.' + C.escapeHtml(String(selected.level != null ? selected.level : '-')) + '</p>';
      html += '<p>背景：' + C.escapeHtml(selected.background || '-') + '</p>';
      if (selected.hp) {
        html += '<p>HP ' + C.escapeHtml(String(selected.hp.current)) + '/' + C.escapeHtml(String(selected.hp.max)) + '</p>';
      }
      html += '<p>属性：STR ' + C.escapeHtml(String(ab.str != null ? ab.str : '-'));
      html += ' DEX ' + C.escapeHtml(String(ab.dex != null ? ab.dex : '-'));
      html += ' CON ' + C.escapeHtml(String(ab.con != null ? ab.con : '-'));
      html += ' INT ' + C.escapeHtml(String(ab.int != null ? ab.int : '-'));
      html += ' WIS ' + C.escapeHtml(String(ab.wis != null ? ab.wis : '-'));
      html += ' CHA ' + C.escapeHtml(String(ab.cha != null ? ab.cha : '-')) + '</p>';
      html += '<p>状态：' + C.escapeHtml(reviewStatusLabel(selected.reviewStatus));
      html += selected.confirmed ? '（已确认）' : '（未确认）';
      html += '</p>';
    } else {
      html += '<p>点击角色查看摘要。</p>';
    }
    C.setHtml('aside-panel-characters', html);
  }

  function renderAsideCombat() {
    var combat = state.combat;
    var html = '';
    if (!combat || !combat.active) {
      html = '<p>当前无战斗。</p>';
    } else {
      var units = combat.units || [];
      if (!units.length) {
        html = '<p>战斗中，暂无单位数据。</p>';
      } else {
        html = '<table><thead><tr><th>单位</th><th>先攻</th><th>状态</th></tr></thead><tbody>';
        units.forEach(function (u) {
          html += '<tr>';
          html += '<td>' + C.escapeHtml(u.name || '') + '</td>';
          html += '<td>' + C.escapeHtml(String(u.initiative != null ? u.initiative : '-')) + '</td>';
          html += '<td>' + C.escapeHtml(C.combatStatusLabel(u.status)) + '</td>';
          html += '</tr>';
        });
        html += '</tbody></table>';
      }
    }
    C.setHtml('aside-panel-combat', html);
  }

  function renderAsideDice() {
    var logs = state.diceLogs || [];
    var html = '';
    if (!logs.length) {
      html = '<p>暂无骰点。</p>';
    } else {
      html = '<ul>';
      logs.forEach(function (d) {
        html += '<li>';
        html += C.escapeHtml(d.actor || '') + ' · ' + C.escapeHtml(d.expression || '');
        html += ' = ' + C.escapeHtml(String(d.result != null ? d.result : ''));
        if (d.note) html += '（' + C.escapeHtml(d.note) + '）';
        html += ' · ' + C.escapeHtml(C.formatTime(d.createdAt));
        html += '</li>';
      });
      html += '</ul>';
    }
    C.setHtml('aside-panel-dice', html);
  }

  function renderAll() {
    renderTopbar();
    renderPlayStatus();
    renderPlayPlayers();
    renderPlayReviews();
    renderPlayLogs();
    renderAiTurn();
    renderCampaignList();
    renderCampaignDetail();
    renderDataSources();
    renderWorldBook();
    renderAiHostDebug();
    renderAiLogs();
    renderPipeline();
    renderAsidePlayers();
    renderAsideCharacters();
    renderAsideCombat();
    renderAsideDice();
  }

  // Initial form fills (once)
  (function fillStaticForms() {
    var ai = state.aiTurn || {};
    var draftEl = C.$('ai-prompt-draft');
    if (draftEl && ai.promptDraft) draftEl.value = ai.promptDraft;

    var host = state.aiHost || {};
    var styleEl = C.$('style-notes');
    if (styleEl) styleEl.value = host.styleNotes || '';
    var rt = host.runtime || {};
    var tempEl = C.$('rt-temperature');
    if (tempEl && rt.temperature != null) tempEl.value = rt.temperature;
    var maxEl = C.$('rt-max-tokens');
    if (maxEl && rt.maxTokens != null) maxEl.value = rt.maxTokens;
    var sceneEl = C.$('rt-scene-type');
    if (sceneEl) sceneEl.value = rt.sceneType || '';

    var settings = state.settings || {};
    var aiP = settings.aiProvider || {};
    var embP = settings.embeddingProvider || {};
    var setAiBase = C.$('set-ai-base');
    if (setAiBase) setAiBase.value = aiP.baseUrl || '';
    var setAiKey = C.$('set-ai-key');
    if (setAiKey) setAiKey.value = aiP.apiKey || '';
    var setAiModel = C.$('set-ai-model');
    if (setAiModel) setAiModel.value = aiP.model || '';
    var setAiEnabled = C.$('set-ai-enabled');
    if (setAiEnabled) setAiEnabled.checked = !!aiP.enabled;

    var setEmbBase = C.$('set-emb-base');
    if (setEmbBase) setEmbBase.value = embP.baseUrl || '';
    var setEmbKey = C.$('set-emb-key');
    if (setEmbKey) setEmbKey.value = embP.apiKey || '';
    var setEmbModel = C.$('set-emb-model');
    if (setEmbModel) setEmbModel.value = embP.model || '';
    var setEmbEnabled = C.$('set-emb-enabled');
    if (setEmbEnabled) setEmbEnabled.checked = !!embP.enabled;

    var asstBase = C.$('asst-base');
    if (asstBase) asstBase.value = aiP.baseUrl || '';
    var asstKey = C.$('asst-key');
    if (asstKey) asstKey.value = aiP.apiKey || '';
    var asstModel = C.$('asst-model');
    if (asstModel) asstModel.value = aiP.model || '';

    var expectedEl = C.$('expected-count');
    if (expectedEl) expectedEl.value = room.expectedPlayerCount != null ? room.expectedPlayerCount : '';
  })();

  // Events
  C.$('btn-add-player').addEventListener('click', function () {
    var nameEl = C.$('new-player-name');
    var name = nameEl ? nameEl.value.trim() : '';
    if (!name) {
      C.showMessage('admin-message', '请输入玩家名', true);
      return;
    }
    var id = C.uid('pl');
    var token = C.uid('p');
    state.players.push({
      id: id,
      token: token,
      name: name,
      roomId: roomId
    });
    room.playerCount = roomPlayers().length;
    if (nameEl) nameEl.value = '新英雄';
    C.showMessage('admin-message', '已添加玩家「' + name + '」');
    renderAll();
  });

  C.$('btn-save-expected').addEventListener('click', function () {
    var el = C.$('expected-count');
    var n = el ? Math.max(1, Math.min(12, Number(el.value) || 1)) : 1;
    room.expectedPlayerCount = n;
    if (el) el.value = n;
    C.showMessage('admin-message', '已保存期望人数：' + n);
    renderAll();
  });

  C.$('play-players').addEventListener('click', function (event) {
    var btn = event.target;
    if (!btn || !btn.getAttribute) return;
    var pid = btn.getAttribute('data-skip-player');
    if (!pid) return;
    var p = playerById(pid);
    C.showMessage('admin-message', '已模拟跳过' + (p ? '「' + p.name + '」' : ''));
  });

  C.$('play-reviews').addEventListener('click', function (event) {
    var btn = event.target;
    if (!btn || !btn.getAttribute) return;
    var approveId = btn.getAttribute('data-approve');
    var rejectId = btn.getAttribute('data-reject');
    if (approveId) {
      var chA = (state.characters || []).find(function (c) { return c.id === approveId; });
      if (chA) {
        chA.reviewStatus = 'approved';
        chA.confirmed = true;
        chA.reviewComment = '';
        C.showMessage('admin-message', '已通过角色「' + chA.name + '」');
        renderAll();
      }
      return;
    }
    if (rejectId) {
      var chR = (state.characters || []).find(function (c) { return c.id === rejectId; });
      if (chR) {
        chR.reviewStatus = 'rejected';
        chR.confirmed = false;
        chR.reviewComment = '审核未通过（mock）';
        C.showMessage('admin-message', '已拒绝角色「' + chR.name + '」');
        renderAll();
      }
    }
  });

  C.$('play-log-objective').addEventListener('click', function () {
    playLogMode = 'objective';
    renderPlayLogs();
  });
  C.$('play-log-public').addEventListener('click', function () {
    playLogMode = 'public';
    renderPlayLogs();
  });
  C.$('play-log-player').addEventListener('click', function () {
    playLogMode = 'player';
    renderPlayLogs();
  });

  C.$('ai-generate').addEventListener('click', function () {
    if (!state.aiTurn) state.aiTurn = {};
    var draftEl = C.$('ai-prompt-draft');
    var draft = draftEl ? draftEl.value : (state.aiTurn.promptDraft || '');
    state.aiTurn.promptDraft = draft;
    state.aiTurn.resultSummary = '（mock 预览）海雾中，玩家行动引发了码头哨兵的警觉。波林的铠甲轻响被雾气吞没，艾拉已贴近无旗船舷。';
    state.aiTurn.message = '已生成预览';
    var pre = C.$('ai-prompt-pre');
    if (pre) pre.textContent = draft;
    C.showMessage('admin-message', '已生成预览');
    renderAiTurn();
  });

  C.$('ai-send').addEventListener('click', function () {
    if (!state.aiTurn) state.aiTurn = {};
    state.aiTurn.message = '已模拟发送';
    C.showMessage('admin-message', '已模拟发送');
    renderAiTurn();
  });

  C.$('ai-apply').addEventListener('click', function () {
    if (!state.aiTurn) state.aiTurn = {};
    state.aiTurn.message = '已模拟应用';
    C.showMessage('admin-message', '已模拟应用');
    renderAiTurn();
  });

  C.$('rollback-btn').addEventListener('click', function () {
    var select = C.$('rollback-select');
    var n = select ? select.value : '';
    if (!n) {
      C.showMessage('admin-message', '请选择回档回合', true);
      return;
    }
    if (!state.aiTurn) state.aiTurn = {};
    state.aiTurn.message = '已模拟回档到回合 ' + n;
    C.showMessage('admin-message', '已模拟回档到回合 ' + n);
    renderAiTurn();
  });

  C.$('campaign-search').addEventListener('input', function () {
    renderCampaignList();
  });
  C.$('campaign-category').addEventListener('change', function () {
    renderCampaignList();
  });

  C.$('campaign-list').addEventListener('click', function (event) {
    var btn = event.target;
    if (!btn || !btn.getAttribute) return;
    var id = btn.getAttribute('data-campaign-id');
    if (!id) return;
    selectedCampaignId = id;
    renderCampaignList();
    renderCampaignDetail();
  });

  C.$('campaign-create-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var titleEl = C.$('cr-title');
    var catEl = C.$('cr-category');
    var sumEl = C.$('cr-summary');
    var title = titleEl ? titleEl.value.trim() : '';
    var category = catEl ? catEl.value : 'world';
    var summary = sumEl ? sumEl.value.trim() : '';
    if (!title) {
      C.showMessage('admin-message', '请填写标题', true);
      return;
    }
    var rec = {
      id: C.uid('cr'),
      category: category,
      title: title,
      summary: summary,
      visibility: 'dm',
      updatedAt: new Date().toISOString().slice(0, 10)
    };
    if (!state.campaignRecords) state.campaignRecords = [];
    state.campaignRecords.unshift(rec);
    selectedCampaignId = rec.id;
    if (titleEl) titleEl.value = '';
    if (sumEl) sumEl.value = '';
    C.showMessage('admin-message', '已创建记录「' + title + '」');
    renderCampaignList();
    renderCampaignDetail();
  });

  C.$('btn-save-style').addEventListener('click', function () {
    if (!state.aiHost) state.aiHost = { runtime: {}, presetBlocks: [] };
    if (!state.aiHost.runtime) state.aiHost.runtime = {};
    var styleEl = C.$('style-notes');
    var tempEl = C.$('rt-temperature');
    var maxEl = C.$('rt-max-tokens');
    var sceneEl = C.$('rt-scene-type');
    state.aiHost.styleNotes = styleEl ? styleEl.value : '';
    state.aiHost.runtime.temperature = tempEl ? Number(tempEl.value) : state.aiHost.runtime.temperature;
    state.aiHost.runtime.maxTokens = maxEl ? Number(maxEl.value) : state.aiHost.runtime.maxTokens;
    state.aiHost.runtime.sceneType = sceneEl ? sceneEl.value : '';
    C.setText('aihost-style-msg', '已保存风格/参数（模拟）');
    C.showMessage('admin-message', '已保存 AI 主持风格/参数');
  });

  C.$('btn-asst-save').addEventListener('click', function () {
    var base = C.$('asst-base');
    var key = C.$('asst-key');
    var model = C.$('asst-model');
    if (!state.settings) state.settings = {};
    if (!state.settings.aiProvider) state.settings.aiProvider = {};
    state.settings.aiProvider.baseUrl = base ? base.value.trim() : '';
    state.settings.aiProvider.apiKey = key ? key.value.trim() : '';
    state.settings.aiProvider.model = model ? model.value.trim() : '';
    C.setText('aihost-asst-msg', '助手配置已保存（模拟）');
    C.showMessage('admin-message', '助手配置已保存（模拟）');
  });

  C.$('btn-asst-test').addEventListener('click', function () {
    C.setText('aihost-asst-msg', '连接测试成功（模拟）');
    C.showMessage('admin-message', '助手连接测试成功（模拟）');
  });

  C.$('btn-settings-save').addEventListener('click', function () {
    if (!state.settings) state.settings = {};
    if (!state.settings.aiProvider) state.settings.aiProvider = {};
    if (!state.settings.embeddingProvider) state.settings.embeddingProvider = {};
    var aiP = state.settings.aiProvider;
    var embP = state.settings.embeddingProvider;
    aiP.baseUrl = (C.$('set-ai-base') || {}).value || '';
    aiP.apiKey = (C.$('set-ai-key') || {}).value || '';
    aiP.model = (C.$('set-ai-model') || {}).value || '';
    aiP.enabled = !!(C.$('set-ai-enabled') && C.$('set-ai-enabled').checked);
    embP.baseUrl = (C.$('set-emb-base') || {}).value || '';
    embP.apiKey = (C.$('set-emb-key') || {}).value || '';
    embP.model = (C.$('set-emb-model') || {}).value || '';
    embP.enabled = !!(C.$('set-emb-enabled') && C.$('set-emb-enabled').checked);
    C.setText('settings-message', '设置已保存（模拟）');
    C.showMessage('admin-message', '设置已保存（模拟）');
  });

  C.$('btn-settings-test').addEventListener('click', function () {
    C.setText('settings-message', 'Provider 测试成功（模拟）');
    C.showMessage('admin-message', 'Provider 测试成功（模拟）');
  });

  C.$('aside-panel-characters').addEventListener('click', function (event) {
    var btn = event.target;
    if (!btn || !btn.getAttribute) return;
    var id = btn.getAttribute('data-aside-char');
    if (!id) return;
    selectedAsideCharacterId = id;
    renderAsideCharacters();
  });

  renderAll();
})();
