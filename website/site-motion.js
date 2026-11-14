'use strict';

(() => {
  const root = document.documentElement;
  root.classList.add('site-enhanced');
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  let preference = 'running';
  try { preference = localStorage.getItem('whale-motion') || 'running'; } catch (_) { /* 不影响当前页面。 */ }
  let paused = media.matches || preference === 'paused';
  const active = new Set();
  const jobs = new WeakMap();
  const presence = new WeakMap();
  const disclosures = new WeakMap();
  const menus = new WeakMap();
  const dialogs = new WeakMap();
  let themeTransition = null;
  let themeReady = Promise.resolve();
  let pressed;

  function cancel(element, key) {
    const map = jobs.get(element); const animation = map?.get(key);
    if (animation) { map.delete(key); animation.cancel(); }
  }
  function animate(element, frames, options = {}, key = 'feedback', complete) {
    cancel(element, key);
    if (paused || !element.animate) { complete?.(); return null; }
    const animation = element.animate(frames, { easing: 'cubic-bezier(.16,1,.3,1)', ...options });
    if (!jobs.has(element)) jobs.set(element, new Map());
    const map = jobs.get(element);
    map.set(key, animation);
    active.add(animation);
    animation.finished.then(() => {
      if (map.get(key) === animation) complete?.();
    }, () => {}).finally(() => {
      const fill = animation.effect?.getTiming().fill;
      if (map.get(key) === animation && !['forwards', 'both'].includes(fill)) map.delete(key);
      active.delete(animation);
    });
    return animation;
  }
  function update() {
    paused = media.matches || preference === 'paused';
    root.dataset.motion = paused ? 'paused' : 'running';
    for (const button of document.querySelectorAll('[data-motion-toggle], #motion-toggle')) {
      button.disabled = media.matches;
      button.setAttribute('aria-pressed', String(paused));
      button.setAttribute('aria-label', media.matches ? '已跟随系统减少动态效果' : paused ? '开启动画' : '暂停动态效果');
      const label = button.querySelector('[data-motion-label]') || (button.id !== 'motion-toggle' ? button.querySelector('span') : null);
      const text = media.matches ? '静态模式' : paused ? '开启动画' : '暂停动画';
      if (label) label.textContent = text;
      else if (button.id === 'motion-toggle') button.textContent = text;
    }
    // 暂停完成当前有效操作，而不是把面板锁在半展开状态。
    if (paused) {
      if (pressed) { cancel(pressed, 'press'); pressed = null; }
      themeTransition?.skipTransition();
      for (const animation of active) { try { animation.finish(); } catch { animation.cancel(); } }
    }
    window.dispatchEvent(new CustomEvent('whale:motion-change', { detail: { paused } }));
  }
  for (const button of document.querySelectorAll('[data-motion-toggle], #motion-toggle')) button.addEventListener('click', () => {
    preference = paused ? 'running' : 'paused';
    try { localStorage.setItem('whale-motion', preference); } catch (_) { /* 存储不可用仍能暂停。 */ }
    update();
  });
  media.addEventListener('change', update);
  window.addEventListener('storage', event => {
    if (event.key === 'whale-motion') { preference = event.newValue || 'running'; update(); }
  });

  function show(item, visible) {
    const state = presence.get(item);
    if (!state || state.inView === visible) return;
    state.inView = visible;
    if (state.locked) return;
    if (!visible && item.contains(document.activeElement)) return;
    const style = getComputedStyle(item);
    const from = { opacity: style.opacity, translate: style.translate === 'none' ? '0px 0px' : style.translate };
    if (visible && Number(style.opacity) < 0.01) from.translate = item.getBoundingClientRect().top < 0 ? '0px -8px' : '0px 12px';
    cancel(item, 'presence');
    item.classList.add('is-visible');
    item.dataset.motionState = visible ? 'entering' : 'leaving';
    const finish = () => {
      item.classList.toggle('is-visible', visible);
      item.dataset.motionState = visible ? 'settled' : 'outside';
      cancel(item, 'presence');
    };
    animate(item, [from, { opacity: visible ? 1 : 0, translate: visible ? '0px 0px' : '0px -7px' }], {
      duration: visible ? 460 : 170, delay: visible && !state.seen ? state.delay : 0, fill: 'forwards',
    }, 'presence', finish);
    state.seen = true;
  }

  let ghostLayer;
  function clearGhosts() {
    if (!ghostLayer) return;
    for (const child of [...ghostLayer.children]) { for (const animation of child.getAnimations()) animation.cancel(); child.remove(); }
  }
  function transitionList(container, mutate) {
    const items = [...container.querySelectorAll('[data-filter-item]')];
    const before = new Map(items.filter(item => !item.hidden).map(item => [item, { rect: item.getBoundingClientRect(), opacity: getComputedStyle(item).opacity }]));
    const oldHeight = container.getBoundingClientRect().height;
    clearGhosts();
    mutate();
    cancel(container, 'height');
    if (paused) return;
    if (container.tagName !== 'TBODY') {
      let count = 0;
      for (const [item, previous] of before) if (item.hidden && previous.rect.bottom > 76 && previous.rect.top < innerHeight && count++ < 6) {
        if (!ghostLayer) {
          ghostLayer = document.createElement('div'); ghostLayer.className = 'motion-ghost-layer';
          ghostLayer.setAttribute('aria-hidden', 'true'); ghostLayer.inert = true; document.body.append(ghostLayer);
        }
        const ghost = item.cloneNode(true);
        ghost.removeAttribute('hidden'); ghost.removeAttribute('data-filter-item'); ghost.removeAttribute('id');
        for (const child of ghost.querySelectorAll('[id],[data-filter-item]')) { child.removeAttribute('id'); child.removeAttribute('data-filter-item'); }
        ghost.classList.remove('motion-item', 'reveal'); ghost.inert = true;
        Object.assign(ghost.style, { left: `${previous.rect.left}px`, top: `${previous.rect.top}px`, width: `${previous.rect.width}px`, height: `${previous.rect.height}px`, transform: 'none' });
        ghostLayer.append(ghost);
        const animation = animate(ghost, [{ opacity: previous.opacity, translate: '0px 0px', scale: 1 }, { opacity: 0, translate: '0px -7px', scale: 0.985 }], { duration: 170 }, 'exit');
        animation?.finished.then(() => ghost.remove(), () => ghost.remove());
      }
    }
    for (const item of items.filter(item => !item.hidden)) {
      const previous = before.get(item);
      const rect = item.getBoundingClientRect();
      if (previous && Math.abs(previous.rect.left - rect.left) < 0.5 && Math.abs(previous.rect.top - rect.top) < 0.5) continue;
      const state = presence.get(item);
      if (state) state.locked = true;
      cancel(item, 'presence'); item.classList.add('is-visible');
      animate(item, [
        { translate: `${previous ? previous.rect.left - rect.left : 0}px ${previous ? previous.rect.top - rect.top : 10}px`, opacity: previous ? previous.opacity : 0.3 },
        { translate: '0px 0px', opacity: 1 },
      ], { duration: 320, delay: previous ? 0 : 60 }, 'layout', () => { if (state) state.locked = false; item.dataset.motionState = 'settled'; });
    }
    if (container.tagName !== 'TBODY') {
      container.style.alignContent = 'start';
      const height = container.getBoundingClientRect().height;
      if (Math.abs(height - oldHeight) > 1) animate(container, [{ height: `${oldHeight}px` }, { height: `${height}px` }], { duration: 320 }, 'height');
    }
  }

  function disclose(details, open) {
    const body = details.querySelector('.disclosure-body');
    if (!body) { details.open = open; return; }
    const old = disclosures.get(details);
    const height = details.open && !body.hidden ? body.getBoundingClientRect().height : 0;
    const opacity = height ? getComputedStyle(body).opacity : 0;
    cancel(body, 'disclosure');
    const state = { open, revision: (old?.revision || 0) + 1 };
    disclosures.set(details, state);
    const summary = details.querySelector('summary');
    summary.setAttribute('aria-expanded', String(open));
    body.hidden = false; details.open = true; body.inert = !open;
    details.dataset.disclosureState = open ? 'opening' : 'closing';
    const finish = () => {
      if (disclosures.get(details) !== state) return;
      details.open = open; body.hidden = !open; body.inert = !open;
      details.dataset.disclosureState = open ? 'open' : 'closed';
      cancel(body, 'disclosure');
    };
    animate(body, [{ height: `${height}px`, opacity }, { height: `${open ? body.scrollHeight : 0}px`, opacity: open ? 1 : 0 }], { duration: open ? 300 : 220, fill: 'forwards' }, 'disclosure', finish);
  }
  for (const details of document.querySelectorAll('details')) {
    const summary = details.querySelector('summary');
    if (!summary) continue;
    const body = document.createElement('div'); body.className = 'disclosure-body';
    for (const child of [...details.childNodes]) if (child !== summary) body.append(child);
    details.append(body); body.hidden = !details.open; body.inert = !details.open;
    disclosures.set(details, { open: details.open, revision: 0 });
    details.dataset.disclosureState = details.open ? 'open' : 'closed';
    summary.setAttribute('aria-expanded', String(details.open));
    summary.addEventListener('click', event => { event.preventDefault(); disclose(details, !disclosures.get(details).open); });
    summary.addEventListener('keydown', event => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      if (!event.repeat) disclose(details, !disclosures.get(details).open);
    });
  }

  function menu(panel, open) {
    if (!matchMedia('(max-width: 900px)').matches) { cancel(panel, 'menu'); panel.classList.remove('open'); panel.inert = false; panel.dataset.panelState = 'desktop'; return; }
    const wasVisible = panel.getBoundingClientRect().height > 0;
    const style = getComputedStyle(panel);
    const from = { opacity: wasVisible ? style.opacity : 0, translate: wasVisible && style.translate !== 'none' ? style.translate : '0px -6px' };
    cancel(panel, 'menu');
    const state = { open }; menus.set(panel, state);
    panel.classList.add('open'); panel.inert = !open; panel.dataset.panelState = open ? 'opening' : 'closing';
    const finish = () => {
      if (menus.get(panel) !== state) return;
      panel.classList.toggle('open', open); panel.dataset.panelState = open ? 'open' : 'closed';
      cancel(panel, 'menu');
    };
    if (!wasVisible && !open) { finish(); return; }
    animate(panel, [from, { opacity: open ? 1 : 0, translate: open ? '0px 0px' : '0px -6px' }], { duration: open ? 240 : 170, fill: 'forwards' }, 'menu', finish);
  }
  function dialog(panel, open) {
    const from = panel.open ? { opacity: getComputedStyle(panel).opacity, translate: getComputedStyle(panel).translate } : { opacity: 0, translate: '0px 10px' };
    cancel(panel, 'dialog');
    const state = { open }; dialogs.set(panel, state);
    if (!panel.open && !open) return;
    if (open && !panel.open) panel.showModal();
    panel.dataset.dialogState = open ? 'opening' : 'closing';
    animate(panel, [from, { opacity: open ? 1 : 0, translate: open ? '0px 0px' : '0px 5px' }], { duration: open ? 250 : 180, fill: 'forwards' }, 'dialog', () => {
      if (dialogs.get(panel) !== state) return;
      if (!open) panel.close(); panel.dataset.dialogState = open ? 'open' : 'closed'; cancel(panel, 'dialog');
    });
  }
  for (const panel of document.querySelectorAll('dialog')) panel.addEventListener('cancel', event => { event.preventDefault(); dialog(panel, false); });

  function theme(mutate, button) {
    themeTransition?.skipTransition();
    if (paused || !document.startViewTransition) {
      mutate(); themeReady = Promise.resolve();
      if (!paused) animate(button, [{ rotate: '-18deg', scale: 0.9 }, { rotate: '0deg', scale: 1 }], { duration: 240 }, 'theme-icon');
      return;
    }
    const transition = document.startViewTransition(mutate); themeTransition = transition;
    const reveal = transition.ready.then(() => {
      if (themeTransition !== transition) return;
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2;
      const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      const animation = animate(root, [{ clipPath: `circle(0px at ${x}px ${y}px)` }, { clipPath: `circle(${radius}px at ${x}px ${y}px)` }], { duration: 320, pseudoElement: '::view-transition-new(root)' }, 'theme');
      return animation?.finished.catch(() => {});
    }).catch(() => {});
    themeReady = Promise.all([transition.updateCallbackDone.catch(() => {}), reveal, transition.finished.catch(() => {})]).then(() => {});
    transition.finished.catch(() => {}).finally(() => { if (themeTransition === transition) themeTransition = null; });
  }

  window.WhaleSiteMotion = { get paused() { return paused; }, get themeReady() { return themeReady; }, transitionList, animate, disclose, menu, dialog, theme };
  update();
  const items = [...document.querySelectorAll('.page-brand-line, .page-intro, .highlight-panel, .install-brief, .archive-row, .plugin-card, .person-card, .credit-card, .support-story, .support-channel, .contribution-card, .stats-grid>div, .table-scroll, .metadata-panel, .release-downloads, .faq-layout')];
  if ('IntersectionObserver' in window) {
    root.classList.add('site-motion-ready');
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) show(entry.target, entry.isIntersecting);
    }, { threshold: 0, rootMargin: '-20px 0px -20px 0px' });
    items.forEach((item, index) => {
      item.classList.add('motion-item'); item.dataset.motionState = 'outside';
      presence.set(item, { inView: null, seen: false, delay: index % 3 * 55, locked: false }); observer.observe(item);
    });
  }
  for (const card of document.querySelectorAll('.plugin-card, .person-card, .support-channel, .contribution-card, .highlight-panel, .whale-signature')) card.addEventListener('pointermove', event => {
    if (paused || !finePointer.matches) return;
    const rect = card.getBoundingClientRect(); card.style.setProperty('--pointer-x', `${event.clientX - rect.left}px`); card.style.setProperty('--pointer-y', `${event.clientY - rect.top}px`);
  });
  function press(target) {
    const element = target.closest('button, a[href], summary');
    if (!element || element.disabled || paused) return;
    pressed = element;
    animate(element, [{ scale: getComputedStyle(element).scale === 'none' ? 1 : getComputedStyle(element).scale }, { scale: 0.975 }], { duration: 95, fill: 'forwards' }, 'press');
  }
  function release() {
    if (!pressed) return;
    const element = pressed; pressed = null;
    animate(element, [{ scale: getComputedStyle(element).scale === 'none' ? 1 : getComputedStyle(element).scale }, { scale: 1 }], { duration: 200, fill: 'forwards' }, 'press', () => cancel(element, 'press'));
  }
  document.addEventListener('pointerdown', event => { if (event.button === 0) press(event.target); });
  document.addEventListener('pointerup', release); document.addEventListener('pointercancel', release);
  document.addEventListener('keydown', event => {
    if (event.key === ' ' && event.target.closest('a')) return;
    if (!event.repeat && ['Enter', ' '].includes(event.key)) press(event.target);
  });
  document.addEventListener('keyup', event => { if (['Enter', ' '].includes(event.key)) release(); });

  let scheduled = false;
  function progress() {
    scheduled = false;
    const range = root.scrollHeight - innerHeight;
    root.style.setProperty('--page-progress', String(range > 0 ? Math.min(1, scrollY / range) : 0));
    root.style.setProperty('--ambient-shift', `${paused ? 0 : Math.min(80, scrollY * 0.035)}px`);
  }
  function scheduleProgress() { if (!scheduled) { scheduled = true; requestAnimationFrame(progress); } }
  addEventListener('scroll', scheduleProgress, { passive: true }); addEventListener('resize', scheduleProgress); progress();
  let navigationAnimation;
  let leaving = false;
  document.addEventListener('click', event => {
    const anchor = event.target.closest('a[href]');
    if (!anchor || paused || leaving || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
    const target = new URL(anchor.href, location.href);
    if (target.origin !== location.origin || target.pathname === location.pathname) return;
    const main = document.querySelector('main'); if (!main?.animate) return;
    event.preventDefault(); leaving = true;
    navigationAnimation = animate(main, [{ opacity: getComputedStyle(main).opacity, translate: '0px 0px' }, { opacity: 0, translate: '0px -6px' }], { duration: 170, fill: 'forwards' }, 'navigation');
    navigationAnimation.finished.catch(() => {}).finally(() => location.assign(target.href));
  });
  addEventListener('pageshow', event => {
    leaving = false; navigationAnimation?.cancel(); navigationAnimation = null; clearGhosts();
    if (event.persisted) for (const animation of active) { try { animation.finish(); } catch { animation.cancel(); } }
  });
})();
