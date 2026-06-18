import { render } from 'preact';
import { App } from '@its/frontend-host';
import '@its/frontend-host/theme.css';

try {
  const raw = localStorage.getItem('its.settings.global.lightMode');
  if (raw && JSON.parse(raw) === true) {
    document.documentElement.dataset.theme = 'light';
  }
} catch {
  // default to dark
}

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
}
