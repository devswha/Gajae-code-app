export function browserSocketUrl(sessionId: string, mode?: 'state'): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/browser?sessionId=${encodeURIComponent(sessionId)}${mode ? `&mode=${mode}` : ''}`;
}
