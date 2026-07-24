(function () {
  var C = window.UI_COMMON;
  var state = window.UI_MOCK.createInitialState();

  function renderRooms() {
    var root = C.$('room-list');
    if (!state.rooms.length) {
      root.innerHTML = '<p>暂无房间。</p>';
      return;
    }
    var html = '<ul>';
    state.rooms.forEach(function (room) {
      var players = state.players.filter(function (p) { return p.roomId === room.id; });
      var firstToken = players[0] ? players[0].token : 'p1';
      html += '<li>';
      html += '<p><strong>' + C.escapeHtml(room.name) + '</strong></p>';
      html += '<p>第 ' + room.currentTurn + ' 回合 · ' + C.roomStatusLabel(room.status);
      html += ' · 玩家 ' + room.playerCount + '/' + (room.expectedPlayerCount || '未设置');
      html += ' · 创建 ' + C.formatTime(room.createdAt) + '</p>';
      html += '<p>';
      html += '<a href="admin.html?room=' + encodeURIComponent(room.id) + '">进入管理</a> · ';
      html += '<a href="player.html?token=' + encodeURIComponent(firstToken) + '">进入玩家</a> · ';
      html += '<button type="button" data-delete-room="' + C.escapeHtml(room.id) + '">删除</button>';
      html += '</p>';
      html += '</li>';
    });
    html += '</ul>';
    root.innerHTML = html;

    root.querySelectorAll('[data-delete-room]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-delete-room');
        var room = state.rooms.find(function (r) { return r.id === id; });
        if (!room) return;
        if (!window.confirm('确定删除房间「' + room.name + '」？此操作会删除该房间的玩家、角色、日志和回合数据。')) return;
        state.rooms = state.rooms.filter(function (r) { return r.id !== id; });
        state.players = state.players.filter(function (p) { return p.roomId !== id; });
        C.showMessage('home-message', '已删除房间「' + room.name + '」');
        renderRooms();
      });
    });
  }

  C.$('create-room-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var name = C.$('room-name').value.trim();
    var count = Math.max(1, Number(C.$('player-count').value) || 1);
    if (!name) {
      C.showMessage('home-message', '请输入房间名称', true);
      return;
    }
    var id = C.uid('room');
    state.rooms.unshift({
      id: id,
      name: name,
      currentTurn: 0,
      status: 'idle',
      playerCount: 0,
      expectedPlayerCount: count,
      createdAt: new Date().toISOString()
    });
    C.$('room-name').value = '';
    C.showMessage('home-message', '已创建房间「' + name + '」（mock，未跳转；可用下方链接进入 demo 或手动改 URL）');
    renderRooms();
  });

  renderRooms();
})();
