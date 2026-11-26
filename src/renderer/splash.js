'use strict';
// Окно проверки обновлений: только показывает то, что присылает главный процесс.
(() => {
  const $ = (id) => document.getElementById(id);
  window.splash.onState((s) => {
    if (s.name !== undefined) $('name').textContent = s.name;
    if (s.sub !== undefined) $('sub').textContent = s.sub;
    $('status').textContent = s.text || '';
    $('status').classList.toggle('done', Boolean(s.done));
    const determinate = typeof s.percent === 'number';
    $('bar').classList.toggle('indeterminate', !determinate);
    $('fill').style.width = determinate ? `${Math.round(s.percent * 100)}%` : '';
    $('detail').textContent = s.detail || '';
    $('pct').textContent = determinate ? `${Math.floor(s.percent * 100)}%` : '';
  });
})();
