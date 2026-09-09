import { Component } from 'react';
import type { ReactNode, RefObject } from 'react';

type Props = {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  sessionKey: string | null;
  enabled: boolean;
  children: ReactNode;
};

type Anchor = { element: HTMLElement; key: string; attribute: 'data-scroll-anchor' | 'data-message-anchor'; offset: number; scrollTop: number };

/** A commit snapshot is required here: an effect cleanup runs after DOM mutation. */
export default class ChatScrollAnchor extends Component<Props, Record<string, never>, Anchor | null> {
  private node: HTMLDivElement | null = null;
  private observer: ResizeObserver | null = null;
  private anchor: Anchor | null = null;
  private frame: number | null = null;
  private previousOverflowAnchor = '';
  private observed = new Set<Element>();

  componentDidMount() {
    this.connect();
    // The containing DOM node's ref can attach after this child's mount lifecycle.
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.connect();
    });
  }

  getSnapshotBeforeUpdate(previous: Props): Anchor | null {
    if (!this.props.enabled || previous.sessionKey !== this.props.sessionKey) return null;
    const snapshot = this.capture();
    if (this.node && this.observer) this.node.style.overflowAnchor = 'none';
    return snapshot;
  }

  componentDidUpdate(previous: Props, _state: Record<string, never>, snapshot: Anchor | null) {
    this.connect();
    this.anchor = snapshot ? this.restore(snapshot) : this.props.enabled ? this.capture() : null;
  }

  componentWillUnmount() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.disconnect();
  }

  private disconnect() {
    this.observer?.disconnect();
    this.observer = null;
    this.observed.clear();
    if (this.node) {
      this.node.removeEventListener('scroll', this.onScroll);
      this.node.style.overflowAnchor = this.previousOverflowAnchor;
    }
    this.node = null;
    this.anchor = null;
  }

  private connect() {
    const node = this.props.scrollContainerRef.current;
    if (this.node !== node) {
      this.disconnect();
      this.node = node;
      if (node) {
        this.previousOverflowAnchor = node.style.overflowAnchor;
        node.addEventListener('scroll', this.onScroll, { passive: true });
        if (typeof ResizeObserver !== 'undefined') this.observer = new ResizeObserver(this.onResize);
      }
    }
    if (!node) return;
    // App-owned anchoring includes late height changes; do not double-correct them.
    node.style.overflowAnchor = this.props.enabled && this.observer ? 'none' : this.previousOverflowAnchor;
    this.observeContent();
    if (!this.anchor && this.props.enabled) this.anchor = this.capture();
  }

  private observeContent() {
    if (!this.node || !this.observer || !this.props.enabled) {
      this.observer?.disconnect();
      this.observed.clear();
      return;
    }
    // Every commit passes through here; only a changed row set re-registers,
    // since each fresh observe also schedules an initial notification.
    const targets = new Set<Element>([this.node]);
    if (this.node.firstElementChild) targets.add(this.node.firstElementChild);
    for (const row of this.node.querySelectorAll('[data-scroll-anchor]')) targets.add(row);
    if (targets.size === this.observed.size && [...targets].every((target) => this.observed.has(target))) return;
    this.observer.disconnect();
    for (const target of targets) this.observer.observe(target);
    this.observed = targets;
  }

  private capture(): Anchor | null {
    const node = this.node ?? this.props.scrollContainerRef.current;
    if (!node) return null;
    const rows = node.querySelectorAll<HTMLElement>('[data-scroll-anchor]');
    const viewport = node.getBoundingClientRect();
    const group = this.firstVisible(rows, viewport);
    if (!group) return null;
    // A group can retain its DOM while prepending children inside it. Preserve
    // the message the reader sees, not the enclosing group's unchanged top.
    const message = this.firstVisible(group.querySelectorAll<HTMLElement>('[data-message-anchor]'), viewport);
    const element = message ?? group;
    const attribute = message ? 'data-message-anchor' : 'data-scroll-anchor';
    const rect = element.getBoundingClientRect();
    return { element, key: element.getAttribute(attribute)!, attribute, offset: rect.top - viewport.top, scrollTop: node.scrollTop };
  }

  private firstVisible(rows: NodeListOf<HTMLElement>, viewport: DOMRect): HTMLElement | null {
    // Each list contains non-nested siblings in transcript order. Binary search
    // only within the visible group avoids measuring all hidden tool output.
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (rows[middle].getBoundingClientRect().bottom <= viewport.top) low = middle + 1;
      else high = middle;
    }
    const element = rows[low];
    if (!element || element.getBoundingClientRect().top >= viewport.bottom) return null;
    return element;
  }

  private restore(saved: Anchor): Anchor | null {
    const node = this.node;
    if (!node) return null;
    const element = node.contains(saved.element) ? saved.element
      : Array.from(node.querySelectorAll<HTMLElement>(`[${saved.attribute}]`)).find(row => row.getAttribute(saved.attribute) === saved.key);
    if (!element) return this.capture();
    const offset = element.getBoundingClientRect().top - node.getBoundingClientRect().top;
    // A wheel/scrollbar move can precede its scroll event. Keep that user movement.
    const wanted = saved.offset - (node.scrollTop - saved.scrollTop);
    const change = offset - wanted;
    if (Math.abs(change) > 0.5) node.scrollTop += change;
    return { element, key: saved.key, attribute: saved.attribute, offset: wanted, scrollTop: node.scrollTop };
  }

  private onScroll = () => {
    if (this.props.enabled && this.node?.scrollTop !== this.anchor?.scrollTop) this.anchor = this.capture();
  };

  private onResize = () => {
    if (!this.props.enabled) return;
    this.anchor = this.anchor ? this.restore(this.anchor) : this.capture();
  };

  render() {
    return this.props.children;
  }
}
