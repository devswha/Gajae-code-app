import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useCallback, useRef } from 'react';

import ChatScrollAnchor from './ChatScrollAnchor';

const nativeObserver = globalThis.ResizeObserver;
const observers = new Set<ResizeObserverCallback>();
class TestObserver {
  constructor(private callback: ResizeObserverCallback) { observers.add(callback); }
  observe() { observers.add(this.callback); }
  disconnect() { observers.delete(this.callback); }
}
globalThis.ResizeObserver = TestObserver as unknown as typeof ResizeObserver;
afterEach(() => { cleanup(); observers.clear(); });
after(() => { globalThis.ResizeObserver = nativeObserver; });

type Row = { id: string; height: number };
const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 200, width: 200, x: 0, y: top, toJSON() {} });

function Harness({ rows, enabled = true, session = 's', grouped = false }: { rows: Row[]; enabled?: boolean; session?: string; grouped?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const attach = useCallback((node: HTMLDivElement | null) => {
    container.current = node;
    if (node) node.getBoundingClientRect = () => rect(0, 100);
  }, []);
  return <div ref={attach} data-testid="pane">
    <ChatScrollAnchor scrollContainerRef={container} enabled={enabled} sessionKey={session}>
      <div data-scroll-anchor={grouped ? 'stable-group' : undefined} ref={node => {
        if (node) node.getBoundingClientRect = () => rect(-(container.current?.scrollTop ?? 0),
          Array.from(node.children).reduce((total, child) => total + Number((child as HTMLElement).dataset.height), 0));
      }}>{rows.map(row => <div key={row.id} data-scroll-anchor={grouped ? undefined : row.id} data-message-anchor={grouped ? row.id : undefined} data-height={row.height} ref={node => {
        if (!node) return;
        node.getBoundingClientRect = () => {
          let top = -(container.current?.scrollTop ?? 0);
          for (const sibling of Array.from(node.parentElement?.children ?? [])) {
            if (sibling === node) break;
            top += Number((sibling as HTMLElement).dataset.height);
          }
          return rect(top, Number(node.dataset.height));
        };
      }}>{row.id}</div>)}</div>
    </ChatScrollAnchor>
  </div>;
}

const initial: Row[] = [{ id: 'a', height: 100 }, { id: 'b', height: 100 }, { id: 'c', height: 100 }];

async function setup(grouped = false, enabled = true) {
  const view = render(<Harness rows={initial} grouped={grouped} enabled={enabled} />);
  await act(async () => { await new Promise(requestAnimationFrame); });
  const pane = view.getByTestId('pane');
  pane.scrollTop = 80;
  fireEvent.scroll(pane);
  return { ...view, pane };
}

test('snapshots the current viewport at commit, excluding concurrent tail growth', async () => {
  const { rerender, pane } = await setup();
  pane.scrollTop = 30;
  // Even before the next scroll event, the current position—not request-time 80—is kept.
  rerender(<Harness rows={[{ id: 'older', height: 200 }, ...initial, { id: 'tail', height: 100 }]} />);
  assert.equal(pane.scrollTop, 230);
});

test('preserves the visible child when older messages extend an expanded group', async () => {
  const { rerender, pane } = await setup(true);
  const child = pane.querySelector('[data-message-anchor="a"]');
  const group = pane.querySelector('[data-scroll-anchor]');
  rerender(<Harness grouped rows={[{ id: 'older', height: 200 }, ...initial]} />);
  assert.equal(pane.querySelector('[data-scroll-anchor]'), group);
  assert.equal(pane.querySelector('[data-message-anchor="a"]'), child);
  assert.equal(pane.scrollTop, 280);
});

test('keeps a nested message stable during late sizing above it', async () => {
  const { rerender, pane } = await setup(true);
  rerender(<Harness grouped rows={[{ id: 'older', height: 200 }, ...initial]} />);
  pane.querySelector<HTMLElement>('[data-message-anchor="older"]')!.dataset.height = '260';
  act(() => {
    for (const callback of observers) callback([], {} as ResizeObserver);
  });
  assert.equal(pane.scrollTop, 340);
});

test('captures before a prepend even when following is disabled in that same commit', async () => {
  const { rerender, pane } = await setup(false, false);
  rerender(<Harness enabled rows={[{ id: 'older', height: 200 }, ...initial]} />);
  assert.equal(pane.scrollTop, 280);
});

test('tail-only updates and unchanged pages do not move the reading position', async () => {
  const { rerender, pane } = await setup();
  rerender(<Harness rows={initial} />);
  assert.equal(pane.scrollTop, 80);
  rerender(<Harness rows={[...initial, { id: 'tail', height: 300 }]} />);
  assert.equal(pane.scrollTop, 80);
});

test('accounts for height decreases above the anchor', async () => {
  const { rerender, pane } = await setup();
  pane.scrollTop = 150;
  fireEvent.scroll(pane);
  rerender(<Harness rows={[{ id: 'a', height: 40 }, ...initial.slice(1)]} />);
  assert.equal(pane.scrollTop, 90);
});

test('does not restore an anchor across a session switch or while following', async () => {
  const { rerender, pane } = await setup();
  rerender(<Harness session="another" rows={[{ id: 'older', height: 200 }, ...initial]} />);
  assert.equal(pane.scrollTop, 80);
  rerender(<Harness session="another" enabled={false} rows={[{ id: 'older', height: 400 }, ...initial]} />);
  assert.equal(pane.scrollTop, 80);
});

test('compensates late row measurement without undoing intervening user scroll', async () => {
  const { rerender, pane } = await setup();
  rerender(<Harness rows={[{ id: 'older', height: 200 }, ...initial]} />);
  const older = pane.querySelector<HTMLElement>('[data-scroll-anchor="older"]')!;
  pane.scrollTop -= 20;
  older.dataset.height = '260';
  act(() => {
    for (const callback of observers) callback([], {} as ResizeObserver);
  });
  assert.equal(pane.scrollTop, 320);
});
