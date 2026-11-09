// Route navigation is shared by both applications. Controls stay mounted so
// switching sections preserves drafts, filters, and in-progress operations.
export function initializeWorkspace({window: win = window, onSettingsChange = () => {}} = {}) {
  const doc = win.document;
  const defaults = {settings: 'connection', tools: 'requests', analysis: 'summary', help: 'start'};
  const selected = {...defaults};
  const views = [...doc.querySelectorAll('.view')];

  function selectPanel(group, requested) {
    const panels = [...doc.querySelectorAll(`[data-section-group="${group}"][data-section-panel]`)];
    if (!panels.length) return;
    const name = panels.some(panel => panel.dataset.sectionPanel === requested) ? requested : panels[0].dataset.sectionPanel;
    selected[group] = name;
    for (const panel of panels) panel.hidden = panel.dataset.sectionPanel !== name;
    for (const link of doc.querySelectorAll(`[data-section-group="${group}"][data-section-link]`)) {
      if (link.dataset.sectionLink === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  function selectSettings(requested) {
    const panels = [...doc.querySelectorAll('[data-settings-panel]')];
    const name = panels.some(panel => panel.dataset.settingsPanel === requested) ? requested : 'connection';
    selected.settings = name;
    for (const panel of panels) panel.hidden = panel.dataset.settingsPanel !== name;
    for (const button of doc.querySelectorAll('[data-settings-tab]')) button.setAttribute('aria-pressed', String(button.dataset.settingsTab === name));
    onSettingsChange(name);
  }

  function showView(scroll = false) {
    const [requested, panel] = win.location.hash.slice(1).split('/');
    const name = views.some(view => view.id === 'view-' + requested) ? requested : 'overview';
    for (const view of views) view.hidden = view.id !== 'view-' + name;
    for (const link of doc.querySelectorAll('[data-view]')) {
      if (link.dataset.view === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (name === 'settings') selectSettings(panel || selected.settings);
    else selectPanel(name, panel || selected[name]);
    const picker = doc.querySelector('.session-picker');
    if (picker) picker.hidden = ['settings', 'help'].includes(name);
    if (scroll) {
      win.scrollTo({top: 0, behavior: 'instant'});
      const heading = doc.querySelector(`#view-${name} h1`);
      heading?.focus({preventScroll: true});
    }
  }

  function showSettings(name = selected.settings) {
    selectSettings(name);
    win.location.hash = 'settings/' + selected.settings;
    showView();
  }
  for (const button of doc.querySelectorAll('[data-settings-tab]')) button.addEventListener('click', () => showSettings(button.dataset.settingsTab));
  for (const link of doc.querySelectorAll('[data-settings-target]')) link.addEventListener('click', event => {
    event.preventDefault(); showSettings(link.dataset.settingsTarget);
  });
  for (const link of doc.querySelectorAll('[data-focus-commands]')) link.addEventListener('click', event => {
    event.preventDefault(); win.location.hash = 'help/commands'; showView(true);
    const guide = doc.getElementById('command-guide');
    if (guide) {guide.open = true; guide.focus();}
  });
  win.addEventListener('hashchange', () => showView(true));
  for (const heading of doc.querySelectorAll('.view h1')) heading.tabIndex = -1;
  for (const group of ['tools', 'analysis', 'help']) selectPanel(group, defaults[group]);
  selectSettings('connection');
  showView();

  const search = doc.getElementById('help-search');
  search?.addEventListener('input', () => {
    const query = search.value.trim().toLocaleLowerCase();
    const cards = [...doc.querySelectorAll('#feature-directory [data-help-feature]')];
    for (const card of cards) card.hidden = !card.textContent.toLocaleLowerCase().includes(query);
    doc.getElementById('help-empty').hidden = cards.some(card => !card.hidden);
  });
  const commandSearch = doc.getElementById('command-search');
  const commandAudience = doc.getElementById('command-audience');
  function filterCommands() {
    const query = commandSearch.value.trim().toLocaleLowerCase();
    const rows = [...doc.querySelectorAll('#command-list tr')];
    for (const row of rows) row.hidden = !row.textContent.toLocaleLowerCase().includes(query) ||
      (commandAudience.value === 'dj' && !row.lastElementChild.textContent.includes('DJ'));
    doc.getElementById('command-empty').hidden = rows.some(row => !row.hidden);
  }
  commandSearch?.addEventListener('input', filterCommands);
  commandAudience?.addEventListener('change', filterCommands);
  return {showSettings, showView};
}
