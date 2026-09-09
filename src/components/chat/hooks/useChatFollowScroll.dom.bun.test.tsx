import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useRef, useState } from 'react';

import { useChatFollowScroll } from './useChatFollowScroll';

type ObserverEntry = { callback: ResizeObserverCallback; target: Element | null };

const observers: ObserverEntry[] = [];
const NativeResizeObserver = globalThis.ResizeObserver;

class TestResizeObserver {
  private readonly entry: ObserverEntry;

  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, target: null };
    observers.push(this.entry);
  }

  observe(target: Element) {
    this.entry.target = target;
  }

  unobserve(target: Element) {
    if (this.entry.target === target) this.entry.target = null;
  }

  disconnect() {
    this.entry.target = null;
  }
}

globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

function notifyResize(target: Element) {
  for (const observer of observers) {
    if (observer.target === target) observer.callback([], {} as ResizeObserver);
  }
}

function Harness() {
  const [height, setHeight] = useState(200);
  const containerRef = useRef<HTMLDivElement>(null);
  const follow = useChatFollowScroll({ scrollContainerRef: containerRef, enabled: true });

  return (
    <>
      <div
        ref={(node) => {
          containerRef.current = node;
          if (!node) return;
          Object.defineProperties(node, {
            clientHeight: { configurable: true, get: () => 100 },
            clientWidth: { configurable: true, get: () => 300 },
            scrollHeight: { configurable: true, get: () => height },
          });
        }}
        data-testid="container"
        style={{ height: 100, overflowY: 'auto' }}
      >
        <div data-testid="content" style={{ height }} />
      </div>
      <button onClick={() => setHeight((value) => value + 100)} type="button">grow</button>
      <button onClick={follow.scrollToBottom} type="button">bottom</button>
      <output data-testid="following">{String(follow.isFollowing)}</output>
    </>
  );
}

function setup() {
  const view = render(<Harness />);
  const container = view.getByTestId('container') as HTMLDivElement;
  const content = view.getByTestId('content');
  const grow = () => {
    act(() => {
      fireEvent.click(view.getByText('grow'));
      notifyResize(content);
    });
  };
  return { ...view, container, content, grow };
}

function assertAtBottom(node: HTMLDivElement) {
  assert.ok(node.scrollHeight - node.scrollTop - node.clientHeight < 50);
}

afterEach(() => {
  cleanup();
  observers.length = 0;
});

test('follows content growth initially', () => {
  const { container, grow } = setup();
  grow();
  assertAtBottom(container);
});

test('wheel-up intent stops following future growth', () => {
  const { container, grow } = setup();
  container.scrollTop = 30;
  fireEvent.wheel(container, { deltaY: -100 });
  grow();
  assert.equal(container.scrollTop, 30);
});

test('scrolling to the bottom resumes following', () => {
  const { container, grow } = setup();
  fireEvent.wheel(container, { deltaY: -100 });
  container.scrollTop = container.scrollHeight - container.clientHeight;
  fireEvent.scroll(container);
  grow();
  assertAtBottom(container);
});

test('scrollToBottom resumes following', () => {
  const { container, getByText, grow } = setup();
  fireEvent.wheel(container, { deltaY: -100 });
  fireEvent.click(getByText('bottom'));
  grow();
  assertAtBottom(container);
});

test('a passive scroll away from the bottom does not stop following', () => {
  const { container, grow } = setup();
  container.scrollTop = 20;
  fireEvent.scroll(container);
  grow();
  assertAtBottom(container);
});

test('scrollbar interaction stops following growth', () => {
  const { container, grow } = setup();
  // The vertical scrollbar track lies past the client box.
  fireEvent.pointerDown(container, { offsetX: 305 });
  container.scrollTop = 30;
  fireEvent.scroll(container);
  grow();
  assert.equal(container.scrollTop, 30);
});

test('a click on the pane gutter keeps following', () => {
  const { container, grow } = setup();
  fireEvent.pointerDown(container, { offsetX: 12 });
  grow();
  assertAtBottom(container);
});

test('PageUp from a transcript child stops following', () => {
  const { container, content, grow } = setup();
  container.scrollTop = 30;
  fireEvent.keyDown(content, { key: 'PageUp' });
  grow();
  assert.equal(container.scrollTop, 30);
});

after(() => {
  globalThis.ResizeObserver = NativeResizeObserver;
});
