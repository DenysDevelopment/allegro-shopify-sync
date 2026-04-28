// Автообновление панели каждые 60 секунд
if (window.location.pathname === '/dashboard' || window.location.pathname === '/dashboard/') {
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      window.location.reload();
    }
  }, 60000);
}

// Кнопки ручной синхронизации
document.querySelectorAll('[data-trigger-sync]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const type = btn.dataset.triggerSync;
    const originalText = btn.textContent;

    btn.disabled = true;
    btn.textContent = 'Синхр...';

    try {
      const res = await fetch(`/dashboard/trigger/${type}`, { method: 'POST' });
      const data = await res.json();

      if (res.ok && data.success) {
        btn.textContent = 'Готово!';
        setTimeout(() => window.location.reload(), 1000);
      } else {
        btn.textContent = 'Ошибка';
        alert('Ошибка синхронизации: ' + (data.error || 'Неизвестная ошибка'));
        setTimeout(() => {
          btn.textContent = originalText;
          btn.disabled = false;
        }, 2000);
      }
    } catch (err) {
      btn.textContent = 'Ошибка';
      alert('Ошибка синхронизации: ' + err.message);
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 2000);
    }
  });
});

// ===== Страница логов =====
if (window.location.pathname === '/dashboard/logs') {
  let currentLevel = 'all';
  let currentSearch = '';
  let autoScroll = true;

  const logOutput = document.getElementById('log-output');
  const logContainer = document.getElementById('log-container');
  const searchInput = document.getElementById('log-search');
  const autoScrollCb = document.getElementById('log-autoscroll');
  const logCount = document.getElementById('log-count');

  document.querySelectorAll('[data-log-level]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-log-level]').forEach(b => b.classList.remove('btn-active'));
      btn.classList.add('btn-active');
      currentLevel = btn.dataset.logLevel;
      fetchLogs();
    });
  });

  let searchTimeout;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      currentSearch = searchInput.value;
      fetchLogs();
    }, 300);
  });

  autoScrollCb.addEventListener('change', () => {
    autoScroll = autoScrollCb.checked;
  });

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  async function fetchLogs() {
    try {
      const params = new URLSearchParams();
      if (currentLevel !== 'all') params.set('level', currentLevel);
      if (currentSearch) params.set('search', currentSearch);

      const res = await fetch(`/dashboard/api/logs?${params}`);
      const logs = await res.json();

      logCount.textContent = `${logs.length} записей`;

      if (!logs.length) {
        logOutput.textContent = 'Нет записей.';
        return;
      }

      logOutput.innerHTML = logs.map(e => {
        const cls = `log-${e.level}`;
        const lvl = e.level.toUpperCase().padEnd(5);
        return `<span class="${cls}">${escapeHtml(e.timestamp)} [${lvl}] ${escapeHtml(e.message)}</span>`;
      }).join('\n');

      if (autoScroll) logContainer.scrollTop = logContainer.scrollHeight;
    } catch (err) {
      logOutput.textContent = 'Ошибка: ' + err.message;
    }
  }

  fetchLogs();
  setInterval(fetchLogs, 3000);
}
