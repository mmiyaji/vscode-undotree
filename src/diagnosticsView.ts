import { randomBytes } from 'crypto';
import { t } from './runtimeL10n';

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const count = (value: number | null) => value === null ? t('unknown') : new Intl.NumberFormat().format(value);
const text = (value: string) => escape(t(value));

export function buildDiagnosticsHtml(snapshot: DiagnosticsSnapshot): string {
    const nonce = randomBytes(16).toString('base64');
    const empty = snapshot.manifestStatus === 'missing' && snapshot.treeFileCount === 0 && snapshot.contentFileCount === 0;
    const indexProblem = snapshot.manifestStatus !== 'ok' && !empty;
    const foreignLive = snapshot.locks.items.filter(item => item.isLive && !item.isOwned).length;
    const orphanCount = (snapshot.orphanTreeFileCount ?? 0) + (snapshot.orphanContentFileCount ?? 0);
    const severity = snapshot.validation.status === 'error' || (indexProblem && snapshot.manifestStatus !== 'backup')
        ? 'error' : indexProblem || snapshot.validation.status !== 'ok' || foreignLive > 0 || orphanCount > 0 ? 'warning' : 'ok';
    const headline = empty ? 'No saved history yet' : severity === 'error' ? 'Persisted history needs attention'
        : severity === 'warning' ? 'Review storage warnings' : 'Persisted history is healthy';
    const statusLabel = snapshot.manifestStatus === 'ok' ? 'Healthy' : snapshot.manifestStatus === 'backup' ? 'Using backup'
        : snapshot.manifestStatus === 'missing' ? 'missing' : 'Unreadable';
    const action = (command: string, label: string, primary = false, disabled = false) =>
        `<button data-command="${command}" class="${primary ? 'primary' : 'secondary'}"${disabled ? ' disabled' : ''}>${text(label)}</button>`;
    const row = (label: string, value: string) => `<div class="fact"><dt>${text(label)}</dt><dd>${value}</dd></div>`;
    const files = (id: string, label: string, items: string[], emptyLabel: string, unknown = false) =>
        `<details id="${id}"${items.length ? ' open' : ''}><summary>${text(label)} <span class="count">${unknown ? text('unknown') : count(items.length)}</span></summary>${unknown
            ? `<p class="hint">${text('Unavailable until the history index and references can be read.')}</p>`
            : items.length ? `<ul class="file-list">${items.slice(0, 50).map(item => `<li><code>${escape(item)}</code></li>`).join('')}</ul>${items.length > 50 ? `<p class="hint">${escape(t('{0} more...', items.length - 50))}</p>` : ''}`
                : `<p class="hint">${text(emptyLabel)}</p>`}</details>`;
    const canPrune = snapshot.manifestStatus === 'ok' && snapshot.validation.status !== 'error' && orphanCount > 0;
    const lockRows = snapshot.locks.items.slice(0, 50).map(item => `<tr>
        <td><code>${escape(item.uri)}</code><span class="hint block">${escape(item.workspace || '-')}</span></td>
        <td>${text(item.isOwned ? 'This window' : 'Other window')}<span class="hint block">${escape(item.sessionId)}</span></td>
        <td>${text(item.isLive ? 'live' : 'stale')}<span class="hint block">${escape(t('{0}s ago', Math.max(0, Math.floor(item.ageMs / 1000))))}</span></td>
      </tr>`).join('');
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  * { box-sizing: border-box; }
  html { scroll-padding-top: 16px; }
  body { margin: 0; padding: 24px; font: 13px/1.5 var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h1, h2, h3, p { margin: 0; }
  h1 { font-size: 20px; font-weight: 600; }
  h2 { font-size: 15px; font-weight: 600; }
  h3 { font-size: 13px; font-weight: 600; }
  .page-header, .section-heading, .action-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .page-header { padding-bottom: 20px; border-bottom: 1px solid var(--vscode-panel-border); }
  .eyebrow, .hint, dt, .count { color: var(--vscode-descriptionForeground); }
  .eyebrow { font-size: 12px; margin-bottom: 4px; }
  .hint { font-size: 12px; }
  .page-header .hint { margin-top: 4px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  button { font: inherit; font-size: 12px; border-radius: 3px; border: 1px solid var(--vscode-button-border, transparent); padding: 5px 10px; cursor: pointer; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
  button:disabled { opacity: .45; cursor: default; }
  button:focus-visible, a:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 3px; }
  button:not(:disabled):hover { filter: brightness(1.12); }
  a { color: var(--vscode-textLink-foreground); }
  .layout { display: grid; grid-template-columns: 156px minmax(0, 1fr); gap: 32px; margin-top: 24px; }
  nav { position: sticky; top: 16px; align-self: start; display: grid; gap: 4px; }
  nav a { color: var(--vscode-descriptionForeground); text-decoration: none; padding: 6px 8px; border-left: 2px solid transparent; }
  nav a:hover, nav a:focus-visible { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
  nav a[aria-current="location"] { color: var(--vscode-textLink-foreground); border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); font-weight: 600; }
  main { min-width: 0; }
  .health { border: 1px solid var(--vscode-panel-border); padding: 16px; border-radius: 3px; }
  .health h2 { display: flex; gap: 8px; align-items: center; }
  .health h2::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-testing-iconPassed); flex: 0 0 8px; }
  .health.warning h2::before { background: var(--vscode-testing-iconQueued); }
  .health.error h2::before { background: var(--vscode-errorForeground); }
  .health .hint { margin-top: 6px; }
  .overview { display: flex; flex-wrap: wrap; gap: 8px 24px; padding-top: 12px; }
  .overview strong { font-variant-numeric: tabular-nums; }
  section { padding: 24px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .section-heading { margin-bottom: 12px; }
  .section-heading + .hint { margin-bottom: 12px; }
  dl { margin: 0; }
  .fact { display: grid; grid-template-columns: minmax(110px, 30%) minmax(0, 1fr); gap: 16px; padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .fact:last-child { border-bottom: 0; }
  dd { margin: 0; overflow-wrap: anywhere; }
  code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; overflow-wrap: anywhere; }
  .action-row { justify-content: flex-start; margin-top: 12px; }
  .action-row .hint { flex: 1 1 220px; }
  .repair { margin: 12px 0; padding: 12px 0; }
  .repair p { margin-bottom: 8px; }
  details { border-top: 1px solid var(--vscode-panel-border); padding: 10px 0; }
  summary { cursor: pointer; font-size: 12px; }
  summary .count { margin-left: 8px; font-variant-numeric: tabular-nums; }
  details > .hint, details > .actions { margin-top: 10px; }
  .file-list { padding-left: 20px; margin: 10px 0 0; }
  .file-list li { margin: 4px 0; }
  .lock-counts { display: flex; gap: 8px 20px; flex-wrap: wrap; margin: 12px 0; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; margin-top: 12px; }
  th, td { text-align: left; padding: 8px; vertical-align: top; overflow-wrap: anywhere; border-bottom: 1px solid var(--vscode-panel-border); }
  th { color: var(--vscode-descriptionForeground); font-weight: 400; }
  th:first-child { width: 50%; }
  .block { display: block; }
  .danger-action { color: var(--vscode-errorForeground); }
  #action-status { min-height: 20px; font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 8px; }
  @media (max-width: 760px) { body { padding: 16px; } .layout { display: block; margin-top: 16px; } nav { position: static; display: flex; flex-wrap: wrap; gap: 4px 8px; margin-bottom: 16px; } nav a { padding: 4px 0; margin-right: 12px; border: 0; } .fact { grid-template-columns: minmax(90px, 34%) minmax(0, 1fr); gap: 10px; } }
</style></head><body>
  <header class="page-header"><div><div class="eyebrow">Undo Tree</div><h1>${text('Diagnostics')}</h1><p class="hint">${text('Inspect saved history and resolve storage issues.')}</p></div>
    <div class="actions">${action('refresh', 'Refresh')}${action('showOutput', 'Open Output')}</div>
  </header>
  <div id="action-status" role="status" aria-live="polite"></div>
  <div class="layout"><nav aria-label="${text('Diagnostics sections')}">
    <a href="#integrity">${text('Integrity')}</a><a href="#storage">${text('Storage')}</a><a href="#windows">${text('Multi-window Locks')}</a><a href="#advanced">${text('Advanced')}</a>
  </nav><main>
    <div class="health ${severity}" role="status"><h2>${text(headline)}</h2>
      <p class="hint">${text(empty ? 'History will appear here after tracked edits are saved.' : severity === 'ok' ? 'No missing or unreadable history was found in this scan.' : 'Review the sections below before changing stored history.')}</p>
      <div class="overview"><span><strong>${count(snapshot.manifestTreeCount)}</strong> ${text('Manifest tree entries')}</span><span><strong>${count(snapshot.treeFileCount)}</strong> ${text('Persisted tree files')}</span><span><strong>${count(snapshot.contentFileCount)}</strong> ${text('Persisted content files')}</span></div>
    </div>
    <section id="integrity" aria-labelledby="integrity-title"><div class="section-heading"><h2 id="integrity-title">${text('Integrity')}</h2>${action('validate', 'Validate Persisted Storage', true)}</div>
      <dl>${row('Manifest status', text(statusLabel))}${row('Checked tree files', count(snapshot.validation.checkedTreeFiles))}${row('Missing tree files', count(snapshot.validation.missingTreeFiles.length))}${row('Unreadable tree files', count(snapshot.validation.unreadableTreeFiles.length))}${row('Missing content hashes', count(snapshot.validation.missingContentHashes.length))}</dl>
      ${indexProblem ? '<div class="repair"><h3>' + text('Repair the history index') + '</h3>' : '<details id="repair-index"><summary>' + text('Repair the history index') + '</summary>'}<p class="hint">${text('Rebuilds the index from readable history files. Missing file contents cannot be recreated.')}</p><div class="actions">${action('rebuildManifest', 'Rebuild Manifest', indexProblem)}</div>${indexProblem ? '</div>' : '</details>'}
      ${files('missing-trees', 'Missing Tree Files', snapshot.validation.missingTreeFiles, 'No missing tree files detected.')}
      ${files('unreadable-trees', 'Unreadable Tree Files', snapshot.validation.unreadableTreeFiles, 'No unreadable tree files detected.')}
      ${files('missing-content', 'Missing Content Hashes', snapshot.validation.missingContentHashes, 'No missing content hashes detected.')}
    </section>
    <section id="storage" aria-labelledby="storage-title"><div class="section-heading"><h2 id="storage-title">${text('Storage')}</h2>${action('openStorage', 'Open Folder')}</div>
      <dl>${row('Storage folder', `<code>${escape(snapshot.storageDir)}</code>`)}${row('manifest.json', snapshot.manifestExists ? `<code>${escape(snapshot.manifestPath)}</code>` : text('missing'))}${row('manifest.json.bak', snapshot.backupExists ? `<code>${escape(snapshot.backupManifestPath)}</code>` : text('missing'))}${row('Orphan tree files', count(snapshot.orphanTreeFileCount))}${row('Orphan content files', count(snapshot.orphanContentFileCount))}</dl>
      <div class="action-row">${action('pruneOrphans', 'Prune Orphan Files', false, !canPrune)}<p class="hint">${text(!canPrune && indexProblem ? 'Repair the history index before cleaning up orphan files.' : !canPrune && snapshot.validation.status === 'error' ? 'Resolve unreadable or missing history before cleaning up.' : orphanCount === 0 ? 'No known orphan files need cleanup.' : 'Referenced history is retained. Content cleanup is skipped while live locks exist.')}</p></div>
      ${files('orphan-trees', 'Orphan Tree Files', snapshot.orphanTreeFiles, 'No orphan tree files detected.', snapshot.orphanTreeFileCount === null)}
      ${files('orphan-content', 'Orphan Content Files', snapshot.orphanContentFiles, 'No orphan content files detected.', snapshot.orphanContentFileCount === null)}
    </section>
    <section id="windows" aria-labelledby="windows-title"><div class="section-heading"><h2 id="windows-title">${text('Multi-window Locks')}</h2></div>
      <p class="hint">${text('Lock files provide conflict warnings, not exclusive access to history.')}</p>
      <div class="lock-counts"><span>${text('Lock warnings')}: ${text(snapshot.locks.enabled ? 'enabled' : 'disabled')}</span><span>${text('Live locks')}: ${count(snapshot.locks.live)}</span><span>${text('Stale locks')}: ${count(snapshot.locks.stale)}</span><span>${text('Owned locks')}: ${count(snapshot.locks.owned)}</span><span>${text('Total locks')}: ${count(snapshot.locks.total)}</span></div>
      ${foreignLive ? `<p>${escape(t('{0} active lock(s) belong to other windows.', foreignLive))}</p>` : ''}
      ${lockRows ? `<table><thead><tr><th>${text('File / workspace')}</th><th>${text('Window')}</th><th>${text('Status / age')}</th></tr></thead><tbody>${lockRows}</tbody></table>${snapshot.locks.items.length > 50 ? `<p class="hint">${escape(t('{0} more...', snapshot.locks.items.length - 50))}</p>` : ''}` : `<p class="hint">${text('No lock files detected.')}</p>`}
      <details id="session-details"><summary>${text('Current session')}</summary><p class="hint"><code>${escape(snapshot.locks.sessionId)}</code></p></details>
    </section>
    <section id="advanced" aria-labelledby="advanced-title"><div class="section-heading"><h2 id="advanced-title">${text('Advanced')}</h2></div>
      <details id="failure-simulation"><summary>${text('Developer tools: simulate storage failures')}</summary><p class="hint">${text('These actions modify the persisted manifest to test recovery. Confirmation is required.')}</p><div class="actions">${action('simulateBackup', 'Simulate backup fallback')}${action('simulateInvalid', 'Simulate invalid manifest')}</div></details>
      <details id="reset-history"><summary class="danger-action">${text('Reset All State')}</summary><p class="hint">${text('Deletes all Undo Tree history from memory and extension storage. This cannot be undone.')}</p><div class="actions">${action('resetAll', 'Reset All State')}</div></details>
    </section>
  </main></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    history.scrollRestoration = 'manual';
    const state = vscode.getState() || {};
    const details = [...document.querySelectorAll('details[id]')];
    for (const item of details) {
      if (typeof state.expanded?.[item.id] === 'boolean') { item.open = state.expanded[item.id]; }
    }
    const saveState = () => vscode.setState({ expanded: Object.fromEntries(details.map(item => [item.id, item.open])), scrollY });
    const links = [...document.querySelectorAll('nav a')];
    const sections = links.map(link => document.getElementById(link.hash.slice(1)));
    function updateSelection() {
      let selected = 0;
      for (let i = 0; i < sections.length; i++) {
        if (sections[i].getBoundingClientRect().top <= 32) { selected = i; }
      }
      if (scrollY > 0 && Math.ceil(scrollY + innerHeight) >= document.documentElement.scrollHeight - 2) {
        selected = sections.length - 1;
      }
      links.forEach((link, index) => {
        if (index === selected) { link.setAttribute('aria-current', 'location'); }
        else { link.removeAttribute('aria-current'); }
      });
    }
    let frame = 0;
    function scheduleSelection() {
      if (!frame) { frame = requestAnimationFrame(() => { frame = 0; updateSelection(); saveState(); }); }
    }
    for (const item of details) { item.addEventListener('toggle', scheduleSelection); }
    window.addEventListener('scroll', scheduleSelection, { passive: true });
    window.addEventListener('resize', scheduleSelection);
    requestAnimationFrame(() => {
      if (Number.isFinite(state.scrollY)) { window.scrollTo(0, state.scrollY); }
      updateSelection();
    });
    let busy = false;
    let enabledButtons = [];
    let activeButton;
    let activeLabel = '';
    const status = document.getElementById('action-status');
    function finish(message) {
      busy = false;
      document.body.setAttribute('aria-busy', 'false');
      if (activeButton) { activeButton.textContent = activeLabel; }
      for (const button of enabledButtons) { button.disabled = false; }
      status.textContent = message || '';
    }
    for (const button of document.querySelectorAll('[data-command]')) {
      button.addEventListener('click', () => {
        if (busy || button.disabled) { return; }
        saveState();
        busy = true;
        activeButton = button;
        activeLabel = button.textContent;
        document.body.setAttribute('aria-busy', 'true');
        enabledButtons = [...document.querySelectorAll('[data-command]')].filter(item => !item.disabled);
        for (const item of enabledButtons) { item.disabled = true; }
        status.textContent = ${JSON.stringify(t('Running: {0}'))}.replace('{0}', activeLabel);
        button.textContent = ${JSON.stringify(t('Running…'))};
        vscode.postMessage({ command: button.dataset.command });
      });
    }
    window.addEventListener('message', event => { if (event.data?.command === 'diagnosticsActionComplete') { finish(event.data.message); } });
  </script>
</body></html>`;
}

export type DiagnosticsSnapshot = {
    manifestStatus: 'ok' | 'backup' | 'missing' | 'invalid';
    storageDir: string;
    manifestPath: string;
    backupManifestPath: string;
    manifestExists: boolean;
    backupExists: boolean;
    manifestTreeCount: number;
    treeFileCount: number;
    contentFileCount: number;
    orphanTreeFileCount: number | null;
    orphanContentFileCount: number | null;
    orphanTreeFiles: string[];
    orphanContentFiles: string[];
    validation: {
        status: 'ok' | 'warning' | 'error';
        checkedTreeFiles: number;
        missingTreeFiles: string[];
        unreadableTreeFiles: string[];
        missingContentHashes: string[];
    };
    locks: {
        enabled: boolean;
        sessionId: string;
        total: number;
        live: number;
        stale: number;
        owned: number;
        items: Array<{
            uri: string;
            sessionId: string;
            workspace: string;
            updatedAt: number;
            ageMs: number;
            isOwned: boolean;
            isLive: boolean;
        }>;
    };
};

