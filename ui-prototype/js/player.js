(function () {
  var C = window.UI_COMMON;
  var state = window.UI_MOCK.createInitialState();
  var token = C.getQuery().token || 'p1';
  var player = state.players.find(function (p) { return p.token === token; });
  if (!player) {
    C.showMessage('player-message', '无效的玩家 token：' + token, true);
    return;
  }

  var character = state.characters.find(function (c) { return c.playerId === player.id; }) || null;
  var room = state.rooms.find(function (r) { return r.id === player.roomId; }) || null;
  var logTab = 'public';

  C.bindTabs(
    [
      { id: 'story', buttonId: 'tab-story', panelId: 'panel-story' },
      { id: 'character', buttonId: 'tab-character', panelId: 'panel-character' },
      { id: 'backpack', buttonId: 'tab-backpack', panelId: 'panel-backpack' },
      { id: 'dm', buttonId: 'tab-dm', panelId: 'panel-dm' }
    ],
    { useHash: true, defaultId: 'story' }
  );

  function ensureBackpack(playerId) {
    if (!state.backpack) state.backpack = {};
    if (!state.backpack[playerId]) {
      state.backpack[playerId] = {
        currency: { gp: 0, sp: 0, cp: 0 },
        items: []
      };
    }
    if (!state.backpack[playerId].currency) {
      state.backpack[playerId].currency = { gp: 0, sp: 0, cp: 0 };
    }
    if (!state.backpack[playerId].items) {
      state.backpack[playerId].items = [];
    }
    return state.backpack[playerId];
  }

  function ensureDmMessages(playerId) {
    if (!state.dmMessages) state.dmMessages = {};
    if (!state.dmMessages[playerId]) {
      state.dmMessages[playerId] = [];
    }
    return state.dmMessages[playerId];
  }

  function refreshCharacter() {
    character = state.characters.find(function (c) { return c.playerId === player.id; }) || null;
  }

  function canSubmitAction() {
    refreshCharacter();
    return !!(character && character.confirmed);
  }

  function renderTopbar() {
    var parts = [player.name];
    if (room) {
      parts.push(room.name);
      parts.push('第 ' + room.currentTurn + ' 回合');
      parts.push(C.roomStatusLabel(room.status));
    } else {
      parts.push('未知房间');
    }
    C.setText('player-topbar-meta', parts.join(' · '));
  }

  function renderStoryLogs() {
    var logs = (state.logs && state.logs[logTab]) || [];
    var html = '';
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
    C.setHtml('story-log-list', html);

    var publicBtn = C.$('log-tab-public');
    var privateBtn = C.$('log-tab-private');
    if (publicBtn) publicBtn.setAttribute('aria-selected', logTab === 'public' ? 'true' : 'false');
    if (privateBtn) privateBtn.setAttribute('aria-selected', logTab === 'private' ? 'true' : 'false');
  }

  function renderInteractions() {
    var list = (state.pendingInteractions || []).filter(function (ix) {
      return ix.playerId === player.id;
    });
    var html = '';
    if (!list.length) {
      html = '<p>暂无待回应互动。</p>';
    } else {
      list.forEach(function (ix) {
        html += '<div data-interaction-id="' + C.escapeHtml(ix.id) + '">';
        html += '<p>' + C.escapeHtml(ix.prompt || '') + '</p>';
        html += '<form data-interaction-form="' + C.escapeHtml(ix.id) + '">';
        html += '<p><label>回应<br /><textarea name="response" rows="3" cols="50" required></textarea></label></p>';
        html += '<p><button type="submit">提交回应</button></p>';
        html += '</form>';
        html += '</div>';
      });
    }
    C.setHtml('interaction-list', html);
  }

  function renderActionForm() {
    var allowed = canSubmitAction();
    var reasonEl = C.$('action-disabled-reason');
    var submitBtn = C.$('action-submit');
    var typeEl = C.$('action-type');
    var textEl = C.$('action-text');
    var existing = state.currentActions && state.currentActions[player.id];

    if (reasonEl) {
      if (!character) {
        reasonEl.textContent = '尚未创建角色，无法提交行动。请先在「人物卡」完善并提交审核。';
      } else if (!character.confirmed) {
        reasonEl.textContent = '角色尚未确认（审核中或未通过），暂时无法提交行动。';
      } else {
        reasonEl.textContent = '';
      }
    }
    if (submitBtn) submitBtn.disabled = !allowed;

    if (existing && existing.actionType && typeEl) {
      typeEl.value = existing.actionType;
    }
    if (textEl && document.activeElement !== textEl) {
      textEl.value = existing && existing.text ? existing.text : textEl.value;
      if (existing && existing.text) textEl.value = existing.text;
    }
  }

  function renderCharacterPanel() {
    refreshCharacter();
    var body = C.$('character-panel-body');
    if (!body) return;

    if (character && (character.reviewStatus === 'approved' || character.confirmed)) {
      var ab = character.abilities || {};
      var skills = character.skills || [];
      var slots = character.spellSlots || {};
      var html = '';
      html += '<p><strong>' + C.escapeHtml(character.name) + '</strong></p>';
      html += '<p>' + C.escapeHtml(character.race || '') + ' · ' + C.escapeHtml(character.className || '');
      html += ' · 等级 ' + C.escapeHtml(String(character.level != null ? character.level : '')) + '</p>';
      html += '<p>背景：' + C.escapeHtml(character.background || '') + '</p>';
      html += '<p>属性：力量 ' + C.escapeHtml(String(ab.str != null ? ab.str : '-'));
      html += ' / 敏捷 ' + C.escapeHtml(String(ab.dex != null ? ab.dex : '-'));
      html += ' / 体质 ' + C.escapeHtml(String(ab.con != null ? ab.con : '-'));
      html += ' / 智力 ' + C.escapeHtml(String(ab.int != null ? ab.int : '-'));
      html += ' / 感知 ' + C.escapeHtml(String(ab.wis != null ? ab.wis : '-'));
      html += ' / 魅力 ' + C.escapeHtml(String(ab.cha != null ? ab.cha : '-')) + '</p>';
      html += '<p>技能：' + C.escapeHtml(skills.length ? skills.join('、') : '无') + '</p>';
      if (character.hp) {
        html += '<p>生命值：' + C.escapeHtml(String(character.hp.current)) + ' / ' + C.escapeHtml(String(character.hp.max)) + '</p>';
      }
      var slotKeys = Object.keys(slots);
      if (slotKeys.length) {
        html += '<p>法术位：';
        html += slotKeys.map(function (lv) {
          var s = slots[lv] || {};
          return lv + ' 环 ' + (s.current != null ? s.current : 0) + '/' + (s.max != null ? s.max : 0);
        }).map(function (t) { return C.escapeHtml(t); }).join('；');
        html += '</p>';
      } else {
        html += '<p>法术位：无</p>';
      }
      html += '<p>状态：已通过审核</p>';
      body.innerHTML = html;
      return;
    }

    if (character && character.reviewStatus === 'pending_review') {
      var pendingHtml = '';
      pendingHtml += '<p><strong>' + C.escapeHtml(character.name) + '</strong>（审核中）</p>';
      pendingHtml += '<p>' + C.escapeHtml(character.race || '') + ' · ' + C.escapeHtml(character.className || '');
      pendingHtml += ' · 背景 ' + C.escapeHtml(character.background || '') + '</p>';
      pendingHtml += '<p>角色卡已提交，等待 DM 审核。审核通过前无法提交行动。</p>';
      body.innerHTML = pendingHtml;
      return;
    }

    var draftName = character ? character.name : '';
    var draftRace = character ? character.race : '';
    var draftClass = character ? character.className : '';
    var draftBg = character ? character.background : '';
    var formHtml = '';
    formHtml += '<p>尚未提交可用角色，请填写基础信息：</p>';
    formHtml += '<form id="character-draft-form">';
    formHtml += '<p><label>姓名 <input name="name" id="char-name" required value="' + C.escapeHtml(draftName || '') + '" /></label></p>';
    formHtml += '<p><label>种族 <input name="race" id="char-race" required value="' + C.escapeHtml(draftRace || '') + '" /></label></p>';
    formHtml += '<p><label>职业 <input name="className" id="char-class" required value="' + C.escapeHtml(draftClass || '') + '" /></label></p>';
    formHtml += '<p><label>背景 <input name="background" id="char-background" value="' + C.escapeHtml(draftBg || '') + '" /></label></p>';
    formHtml += '<p><button type="submit">提交审核</button></p>';
    formHtml += '</form>';
    body.innerHTML = formHtml;
  }

  function renderBackpack() {
    var pack = ensureBackpack(player.id);
    var cur = pack.currency || {};
    C.setText(
      'backpack-currency',
      '货币：' + (cur.gp != null ? cur.gp : 0) + ' gp / ' +
        (cur.sp != null ? cur.sp : 0) + ' sp / ' +
        (cur.cp != null ? cur.cp : 0) + ' cp'
    );

    var items = pack.items || [];
    var html = '';
    if (!items.length) {
      html = '<p>背包为空。</p>';
    } else {
      html = '<table><thead><tr><th>名称</th><th>数量</th><th>备注</th><th></th></tr></thead><tbody>';
      items.forEach(function (item) {
        html += '<tr>';
        html += '<td>' + C.escapeHtml(item.name || '') + '</td>';
        html += '<td>' + C.escapeHtml(String(item.qty != null ? item.qty : 1)) + '</td>';
        html += '<td>' + C.escapeHtml(item.note || '') + '</td>';
        html += '<td><button type="button" data-item-id="' + C.escapeHtml(item.id) + '">删除</button></td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
    }
    C.setHtml('backpack-items', html);
  }

  function renderDmMessages() {
    var messages = ensureDmMessages(player.id);
    var html = '';
    if (!messages.length) {
      html = '<p>暂无对话。</p>';
    } else {
      html = '<ul>';
      messages.forEach(function (msg) {
        var role = msg.role === 'user' ? '你' : '助手';
        html += '<li><p><strong>' + C.escapeHtml(role) + '</strong></p>';
        html += '<p>' + C.escapeHtml(msg.content || '') + '</p></li>';
      });
      html += '</ul>';
    }
    C.setHtml('dm-messages', html);
  }

  function renderAsideCharacter() {
    refreshCharacter();
    var html = '';
    if (!character) {
      html = '<p>未绑定角色</p>';
    } else {
      html += '<p><strong>' + C.escapeHtml(character.name) + '</strong></p>';
      html += '<p>' + C.escapeHtml(character.race || '') + ' · ' + C.escapeHtml(character.className || '');
      html += ' · Lv.' + C.escapeHtml(String(character.level != null ? character.level : '-')) + '</p>';
      if (character.hp) {
        html += '<p>HP ' + C.escapeHtml(String(character.hp.current)) + '/' + C.escapeHtml(String(character.hp.max)) + '</p>';
      }
      var statusLabel = character.confirmed
        ? '已确认'
        : (character.reviewStatus === 'pending_review' ? '审核中' : (character.reviewStatus || '草稿'));
      html += '<p>' + C.escapeHtml(statusLabel) + '</p>';
    }
    C.setHtml('aside-character', html);
  }

  function renderAsideAction() {
    var action = state.currentActions && state.currentActions[player.id];
    var html = '';
    if (!action) {
      html = '<p>本回合尚未提交行动。</p>';
    } else {
      html += '<p>类型：' + C.escapeHtml(C.actionTypeLabel(action.actionType)) + '</p>';
      html += '<p>' + C.escapeHtml(action.text || '') + '</p>';
    }
    C.setHtml('aside-action', html);
  }

  function renderAsideRoom() {
    var html = '';
    if (!room) {
      html = '<p>未知房间</p>';
    } else {
      html += '<p>' + C.escapeHtml(room.name) + '</p>';
      html += '<p>第 ' + room.currentTurn + ' 回合 · ' + C.escapeHtml(C.roomStatusLabel(room.status)) + '</p>';
      html += '<p>玩家 ' + room.playerCount + '/' + (room.expectedPlayerCount || '?') + '</p>';
    }
    var waiting = state.waitingPlayers || [];
    if (waiting.length) {
      html += '<p>等待中：' + C.escapeHtml(waiting.join('、')) + '</p>';
    } else {
      html += '<p>等待中：无</p>';
    }
    C.setHtml('aside-room', html);
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
    C.setHtml('aside-combat', html);
  }

  function renderAsideDice() {
    var logs = state.diceLogs || [];
    var html = '';
    if (!logs.length) {
      html = '<p>暂无骰点。</p>';
    } else {
      html = '<ul>';
      logs.slice(0, 8).forEach(function (d) {
        html += '<li>';
        html += C.escapeHtml(d.actor || '') + ' · ' + C.escapeHtml(d.expression || '');
        html += ' = ' + C.escapeHtml(String(d.result != null ? d.result : ''));
        if (d.note) html += '（' + C.escapeHtml(d.note) + '）';
        html += '</li>';
      });
      html += '</ul>';
    }
    C.setHtml('aside-dice', html);
  }

  function renderAll() {
    renderTopbar();
    renderStoryLogs();
    renderInteractions();
    renderActionForm();
    renderCharacterPanel();
    renderBackpack();
    renderDmMessages();
    renderAsideCharacter();
    renderAsideAction();
    renderAsideRoom();
    renderAsideCombat();
    renderAsideDice();
  }

  // Static handlers
  C.$('log-tab-public').addEventListener('click', function () {
    logTab = 'public';
    renderStoryLogs();
  });
  C.$('log-tab-private').addEventListener('click', function () {
    logTab = 'private';
    renderStoryLogs();
  });

  C.$('action-submit').addEventListener('click', function () {
    if (!canSubmitAction()) {
      C.showMessage('player-message', '当前无法提交行动', true);
      return;
    }
    var typeEl = C.$('action-type');
    var textEl = C.$('action-text');
    var actionType = typeEl ? typeEl.value : 'in_character_action';
    var text = textEl ? textEl.value.trim() : '';
    if (!text) {
      C.showMessage('player-message', '请填写行动内容', true);
      return;
    }
    if (!state.currentActions) state.currentActions = {};
    state.currentActions[player.id] = { actionType: actionType, text: text };
    C.showMessage('player-message', '行动已提交（mock）');
    renderAll();
  });

  C.$('interaction-list').addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.getAttribute || !form.getAttribute('data-interaction-form')) return;
    event.preventDefault();
    var id = form.getAttribute('data-interaction-form');
    var textarea = form.querySelector('textarea[name="response"]');
    var response = textarea ? textarea.value.trim() : '';
    if (!response) {
      C.showMessage('player-message', '请填写互动回应', true);
      return;
    }
    var ix = (state.pendingInteractions || []).find(function (item) { return item.id === id; });
    if (ix) ix.response = response;
    state.pendingInteractions = (state.pendingInteractions || []).filter(function (item) {
      return item.id !== id;
    });
    if (!state.logs) state.logs = { public: [], private: [], objective: [] };
    if (!state.logs.private) state.logs.private = [];
    state.logs.private.push({
      id: C.uid('lg'),
      createdAt: new Date().toISOString(),
      speaker: '系统',
      content: '你回应了互动：「' + response + '」'
    });
    C.showMessage('player-message', '互动回应已提交（mock）');
    renderAll();
  });

  C.$('backpack-add-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var nameEl = C.$('item-name');
    var qtyEl = C.$('item-qty');
    var noteEl = C.$('item-note');
    var name = nameEl ? nameEl.value.trim() : '';
    var qty = qtyEl ? Math.max(1, Number(qtyEl.value) || 1) : 1;
    var note = noteEl ? noteEl.value.trim() : '';
    if (!name) {
      C.showMessage('player-message', '请填写物品名称', true);
      return;
    }
    var pack = ensureBackpack(player.id);
    pack.items.push({ id: C.uid('it'), name: name, qty: qty, note: note });
    if (nameEl) nameEl.value = '';
    if (qtyEl) qtyEl.value = '1';
    if (noteEl) noteEl.value = '';
    C.showMessage('player-message', '已添加物品「' + name + '」');
    renderAll();
  });

  C.$('backpack-items').addEventListener('click', function (event) {
    var btn = event.target;
    if (!btn || !btn.getAttribute) return;
    var itemId = btn.getAttribute('data-item-id');
    if (!itemId) return;
    var pack = ensureBackpack(player.id);
    pack.items = (pack.items || []).filter(function (item) { return item.id !== itemId; });
    C.showMessage('player-message', '已删除物品');
    renderAll();
  });

  C.$('dm-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var input = C.$('dm-input');
    var text = input ? input.value.trim() : '';
    if (!text) {
      C.showMessage('player-message', '请输入问题', true);
      return;
    }
    var messages = ensureDmMessages(player.id);
    messages.push({ id: C.uid('m'), role: 'user', content: text });
    messages.push({
      id: C.uid('m'),
      role: 'assistant',
      content: '（mock）已记录你的问题，正式环境将由 DM 助手回答。'
    });
    if (input) input.value = '';
    C.showMessage('player-message', '已发送给 DM 助手（mock）');
    renderAll();
  });

  C.$('character-panel-body').addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || form.id !== 'character-draft-form') return;
    event.preventDefault();
    var nameInput = form.querySelector('#char-name') || form.querySelector('[name="name"]');
    var raceInput = form.querySelector('#char-race') || form.querySelector('[name="race"]');
    var classInput = form.querySelector('#char-class') || form.querySelector('[name="className"]');
    var bgInput = form.querySelector('#char-background') || form.querySelector('[name="background"]');
    var name = nameInput ? nameInput.value.trim() : '';
    var race = raceInput ? raceInput.value.trim() : '';
    var className = classInput ? classInput.value.trim() : '';
    var background = bgInput ? bgInput.value.trim() : '';
    if (!name || !race || !className) {
      C.showMessage('player-message', '请填写姓名、种族与职业', true);
      return;
    }
    refreshCharacter();
    if (character) {
      character.name = name;
      character.race = race;
      character.className = className;
      character.background = background;
      character.reviewStatus = 'pending_review';
      character.confirmed = false;
    } else {
      character = {
        id: C.uid('ch'),
        playerId: player.id,
        name: name,
        race: race,
        className: className,
        level: 1,
        background: background,
        confirmed: false,
        reviewStatus: 'pending_review',
        reviewComment: '',
        abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        skills: [],
        hp: { current: 8, max: 8 },
        spellSlots: {}
      };
      state.characters.push(character);
    }
    C.showMessage('player-message', '角色已提交审核（mock）');
    renderAll();
  });

  // Prefill action from currentActions once
  (function prefillAction() {
    var existing = state.currentActions && state.currentActions[player.id];
    if (!existing) return;
    var typeEl = C.$('action-type');
    var textEl = C.$('action-text');
    if (typeEl && existing.actionType) typeEl.value = existing.actionType;
    if (textEl && existing.text) textEl.value = existing.text;
  })();

  renderAll();
})();
