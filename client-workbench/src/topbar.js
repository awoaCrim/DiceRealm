import {closeButton} from './dom.js';

// Only floating topbar panels behave as dismissible layers.
// Inline document details keep their native summary interaction.
export function setupTopbarPanels(doc = document) {
  const panels = ['reading-controls', 'account-controls'].map(id => doc.getElementById(id));
  for (const panel of panels) {
    const summary = panel.querySelector('summary');
    const dismiss = () => {
      panel.open = false;
      summary.focus();
    };
    panel.querySelector('.topbar-panel').prepend(closeButton('关闭' + (summary.getAttribute('aria-label') || summary.textContent), dismiss));
    // Account actions navigate or log out; dismiss before the view changes.
    if (panel.id === 'account-controls') {
      panel.querySelectorAll('.btn').forEach(button => button.addEventListener('click', dismiss));
    }
    panel.addEventListener('toggle', () => {
      if (panel.open) for (const other of panels) if (other !== panel) other.open = false;
    });
  }
  doc.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
    // A native dialog owns Esc while open; never dismiss both layers with one key.
    if (doc.querySelector('dialog[open]')) return;
    const panel = panels.find(item => item.open);
    if (!panel) return;
    event.preventDefault();
    panel.open = false;
    panel.querySelector('summary').focus();
  });
}
