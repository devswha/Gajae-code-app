import './styles.css';
import { renderLandingPage } from './page.js';
import { initDownloadPicker } from './download-picker.js';

function el(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content;
}

document.getElementById('app').replaceChildren(el(renderLandingPage()));
const disposeDownloadPicker = initDownloadPicker(document);

if (import.meta.hot) import.meta.hot.dispose(disposeDownloadPicker);
