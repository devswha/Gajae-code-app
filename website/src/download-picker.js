// A disclosure with ordinary links: Tab stays native and never traps focus.
export function initDownloadPicker(root) {
  const picker = root.querySelector('[data-download-picker]');
  if (!picker) return () => {};

  const toggle = picker.querySelector('[data-download-toggle]');
  const panel = picker.querySelector('[data-download-panel]');
  const links = [...panel.querySelectorAll('a[href]')];
  const document = picker.ownerDocument;

  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  }

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) toggle.focus();
  }

  function onToggle() {
    setOpen(panel.hidden);
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && !panel.hidden) {
      event.preventDefault();
      close(true);
      return;
    }

    const index = links.indexOf(document.activeElement);
    const toggleFocused = document.activeElement === toggle;
    if (!toggleFocused && (panel.hidden || index < 0)) return;

    let next;
    if (event.key === 'ArrowDown') next = toggleFocused ? 0 : (index + 1) % links.length;
    else if (event.key === 'ArrowUp') next = toggleFocused ? links.length - 1 : (index - 1 + links.length) % links.length;
    else if (!toggleFocused && event.key === 'Home') next = 0;
    else if (!toggleFocused && event.key === 'End') next = links.length - 1;
    else return;

    event.preventDefault();
    setOpen(true);
    links[next].focus();
  }

  function onDocumentClick(event) {
    if (panel.hidden) return;
    if (!picker.contains(event.target)) close(panel.contains(document.activeElement));
    else if (links.some((link) => link.contains(event.target))) close(true);
  }

  function onFocusIn(event) {
    if (!picker.contains(event.target)) close();
  }

  setOpen(false);
  toggle.addEventListener('click', onToggle);
  picker.addEventListener('keydown', onKeyDown);
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('focusin', onFocusIn);

  return () => {
    close(panel.contains(document.activeElement));
    toggle.removeEventListener('click', onToggle);
    picker.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('focusin', onFocusIn);
  };
}
