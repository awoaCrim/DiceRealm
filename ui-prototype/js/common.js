(function (global) {
  function $(id) {
    return document.getElementById(id);
  }

  function getQuery() {
    var params = new URLSearchParams(window.location.search);
    var out = {};
    params.forEach(function (value, key) {
      out[key] = value;
    });
    return out;
  }

  function roomStatusLabel(status) {
    var map = {
      waiting_for_actions: '等待行动',
      waiting_for_interaction: '等待互动回应',
      ready_to_resolve: '待结算',
      resolving: '结算中',
      idle: '空闲'
    };
    return map[status] || status || '未知';
  }

  function combatStatusLabel(status) {
    var map = {
      healthy: '良好',
      injured: '受伤',
      bloodied: '重伤',
      defeated: '倒下'
    };
    return map[status] || status || '未知';
  }

  function actionTypeLabel(type) {
    var map = {
      in_character_action: '角色行动',
      player_question: '提问',
      observe: '观察',
      wait: '等待',
      combat_action: '战斗',
      skip: '跳过'
    };
    return map[type] || type || '行动';
  }

  function formatTime(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('zh-CN', { hour12: false });
    } catch (e) {
      return iso;
    }
  }

  function setText(id, text) {
    var el = $(id);
    if (el) el.textContent = text == null ? '' : String(text);
  }

  function setHtml(id, html) {
    var el = $(id);
    if (el) el.innerHTML = html;
  }

  function showMessage(id, text, isError) {
    var el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
    if (text) el.setAttribute('data-kind', isError ? 'error' : 'ok');
  }

  /**
   * tabs: [{ id: 'story', buttonId: 'tab-story', panelId: 'panel-story' }, ...]
   * options.hashPrefix optional, default ''
   */
  function bindTabs(tabs, options) {
    options = options || {};
    var storageKey = options.storageKey || '';
    var defaultId = options.defaultId || (tabs[0] && tabs[0].id);

    function activate(id) {
      var found = false;
      tabs.forEach(function (tab) {
        var on = tab.id === id;
        if (on) found = true;
        var btn = $(tab.buttonId);
        var panel = $(tab.panelId);
        if (btn) {
          btn.setAttribute('aria-selected', on ? 'true' : 'false');
          if (on) btn.setAttribute('data-active', '1');
          else btn.removeAttribute('data-active');
        }
        if (panel) panel.hidden = !on;
      });
      if (!found && defaultId) return activate(defaultId);
      if (storageKey) {
        try { sessionStorage.setItem(storageKey, id); } catch (e) { /* ignore */ }
      }
      if (options.useHash) {
        var hash = '#' + id;
        if (window.location.hash !== hash) {
          history.replaceState(null, '', hash);
        }
      }
      if (typeof options.onChange === 'function') options.onChange(id);
    }

    tabs.forEach(function (tab) {
      var btn = $(tab.buttonId);
      if (!btn) return;
      btn.addEventListener('click', function () {
        activate(tab.id);
      });
    });

    var initial = defaultId;
    if (options.useHash && window.location.hash) {
      initial = window.location.hash.replace(/^#/, '') || defaultId;
    } else if (storageKey) {
      try {
        initial = sessionStorage.getItem(storageKey) || defaultId;
      } catch (e) {
        initial = defaultId;
      }
    }
    activate(initial);
    return { activate: activate };
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 9);
  }

  global.UI_COMMON = {
    $: $,
    getQuery: getQuery,
    roomStatusLabel: roomStatusLabel,
    combatStatusLabel: combatStatusLabel,
    actionTypeLabel: actionTypeLabel,
    formatTime: formatTime,
    setText: setText,
    setHtml: setHtml,
    showMessage: showMessage,
    bindTabs: bindTabs,
    escapeHtml: escapeHtml,
    uid: uid
  };
})(window);
