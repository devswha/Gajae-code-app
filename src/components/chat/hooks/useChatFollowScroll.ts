import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject, SetStateAction } from 'react';

const BOTTOM_THRESHOLD = 50;

type UseChatFollowScrollArgs = {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
};

function isNearBottom(node: HTMLDivElement) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < BOTTOM_THRESHOLD;
}

export function useChatFollowScroll({ scrollContainerRef, enabled }: UseChatFollowScrollArgs) {
  const [isFollowing, setIsFollowing] = useState(true);
  const isFollowingRef = useRef(true);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const setFollowing = useCallback((value: SetStateAction<boolean>) => {
    const following = typeof value === 'function' ? value(isFollowingRef.current) : value;
    isFollowingRef.current = following;
    setIsFollowing(following);
  }, []);
  const follow = useCallback(() => setFollowing(true), [setFollowing]);
  const scrollToBottom = useCallback(() => {
    const node = scrollContainerRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    setFollowing(true);
  }, [scrollContainerRef, setFollowing]);
  const handleScroll = useCallback(() => {
    const node = scrollContainerRef.current;
    if (node && isNearBottom(node)) follow();
  }, [follow, scrollContainerRef]);

  useEffect(() => {
    const node = scrollContainerRef.current;
    if (!node) return;

    const stopFollowing = () => setFollowing(false);
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stopFollowing();
    };
    let touchStartY: number | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touchStartY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const touchY = event.touches[0]?.clientY;
      if (touchStartY !== null && touchY !== undefined && touchY > touchStartY) stopFollowing();
    };
    const onPointerDown = (event: PointerEvent) => {
      // Only a grab of the vertical scrollbar track (past the client box) is a
      // scroll intent; the pane's own gutter and padding also report the node.
      if (event.target === node && event.offsetX >= node.clientWidth) stopFollowing();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const editing = target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
      if (!editing && ['ArrowUp', 'PageUp', 'Home'].includes(event.key)) stopFollowing();
    };

    node.addEventListener('scroll', handleScroll, { passive: true });
    node.addEventListener('wheel', onWheel, { passive: true });
    node.addEventListener('touchstart', onTouchStart, { passive: true });
    node.addEventListener('touchmove', onTouchMove, { passive: true });
    node.addEventListener('pointerdown', onPointerDown, { passive: true });
    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('scroll', handleScroll);
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('keydown', onKeyDown);
    };
  }, [handleScroll, scrollContainerRef, setFollowing]);

  useEffect(() => {
    const node = scrollContainerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let content = node.firstElementChild;
    const observer = new ResizeObserver(() => {
      if (isFollowingRef.current && enabledRef.current) node.scrollTop = node.scrollHeight;
    });
    if (content) observer.observe(content);
    const frame = requestAnimationFrame(() => {
      const nextContent = node.firstElementChild;
      if (nextContent && nextContent !== content) {
        if (content) observer.unobserve(content);
        content = nextContent;
        observer.observe(content);
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [enabled, scrollContainerRef]);

  return { isFollowing, setFollowing, follow, scrollToBottom, handleScroll };
}
