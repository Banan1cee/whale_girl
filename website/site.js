'use strict';

// 子页面不加载首页叙事脚本，导航与主题在同一个入口维护。
(() => {
  const root = document.documentElement;
  const themeButton = document.querySelector('#theme-toggle');
  const themeMedia = matchMedia('(prefers-color-scheme: light)');
  let explicitTheme = false;
  let requestedTheme = root.dataset.theme;
  try { explicitTheme = ['light', 'dark'].includes(localStorage.getItem('whale-theme')); } catch (_) { /* 存储不可用仍可切换。 */ }
  function updateThemeLabel() {
    themeButton.setAttribute('aria-label', root.dataset.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
    document.querySelector('meta[name="theme-color"]').content = root.dataset.theme === 'dark' ? '#191c1a' : '#ffffff';
  }
  themeButton.addEventListener('click', () => {
    requestedTheme = requestedTheme === 'dark' ? 'light' : 'dark';
    explicitTheme = true;
    try { localStorage.setItem('whale-theme', requestedTheme); } catch (_) { /* 不阻止当前页面选择。 */ }
    const apply = () => { root.dataset.theme = requestedTheme; updateThemeLabel(); };
    if (window.WhaleSiteMotion) window.WhaleSiteMotion.theme(apply, themeButton);
    else apply();
  });
  themeMedia.addEventListener('change', event => {
    if (!explicitTheme) { requestedTheme = event.matches ? 'light' : 'dark'; root.dataset.theme = requestedTheme; updateThemeLabel(); }
  });
  updateThemeLabel();

  const menuButton = document.querySelector('.menu-toggle');
  const navLinks = document.querySelector('.nav-links');
  function closeMenu() {
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-label', '打开导航');
    if (window.WhaleSiteMotion) window.WhaleSiteMotion.menu(navLinks, false);
    else navLinks.classList.remove('open');
  }
  menuButton.addEventListener('click', () => {
    const open = menuButton.getAttribute('aria-expanded') !== 'true';
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? '关闭导航' : '打开导航');
    if (window.WhaleSiteMotion) window.WhaleSiteMotion.menu(navLinks, open);
    else navLinks.classList.toggle('open', open);
  });
  navLinks.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && navLinks.classList.contains('open')) { closeMenu(); menuButton.focus(); }
  });
  document.addEventListener('click', event => { if (!event.target.closest('.nav')) closeMenu(); });
  matchMedia('(min-width: 901px)').addEventListener('change', closeMenu);
  const year = document.querySelector('#year');
  if (year) year.textContent = new Date().getFullYear();

  const filters = document.querySelector('[data-filters]');
  if (!filters) return;
  const items = [...document.querySelectorAll('[data-filter-item]')];
  const search = filters.querySelector('[type="search"]');
  const selects = [...filters.querySelectorAll('select[data-key]')];
  const sorting = filters.querySelector('[data-sort]');
  const list = document.querySelector('[data-motion-list], .archive-list, .tips-table tbody');
  const status = document.querySelector('#filter-status');
  const empty = document.querySelector('#filter-empty');
  const amount = document.querySelector('#filtered-amount');
  function applyFilters() {
    const query = (search?.value || '').normalize('NFKC').toLocaleLowerCase().trim();
    const mutate = () => {
      let count = 0;
      let total = 0;
      for (const item of items) {
        const matches = (!query || item.dataset.search.normalize('NFKC').toLocaleLowerCase().includes(query))
          && selects.every(select => !select.value || item.dataset[select.dataset.key] === select.value);
        item.hidden = !matches;
        if (matches) { count += 1; total += Number(item.dataset.amount || 0); }
      }
      if (sorting && list) {
        const key = sorting.value;
        const ordered = [...items].sort((a, b) => key === 'catalog'
          ? Number(a.dataset.order) - Number(b.dataset.order)
          : (a.dataset[key] || '').localeCompare(b.dataset[key] || '', 'zh-CN'));
        for (const item of ordered) list.append(item);
      }
      const kind = selects.find(select => select.dataset.key === 'kind')?.value || '';
      for (const button of document.querySelectorAll('[data-kind-choice]')) button.setAttribute('aria-pressed', String(button.dataset.kindChoice === kind));
      status.textContent = `显示 ${count} 条，共 ${items.length} 条`;
      if (empty) empty.hidden = count !== 0 || items.length === 0;
      if (amount) amount.textContent = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(total / 100);
    };
    if (list && window.WhaleSiteMotion) window.WhaleSiteMotion.transitionList(list, mutate);
    else mutate();
  }
  filters.hidden = false;
  filters.addEventListener('input', applyFilters);
  filters.addEventListener('change', applyFilters);
  for (const button of document.querySelectorAll('[data-kind-choice]')) button.addEventListener('click', () => {
    const select = selects.find(item => item.dataset.key === 'kind');
    if (select) { select.value = button.dataset.kindChoice; applyFilters(); }
  });
  applyFilters();
})();
