import { useEffect, useRef, useState } from 'react';

export function useAnimatedEval(targetValue: number | null) {
  const [displayedValue, setDisplayedValue] = useState<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const displayedValueRef = useRef<number | null>(null);

  useEffect(() => {
    displayedValueRef.current = displayedValue;
  }, [displayedValue]);

  useEffect(() => {
    if (targetValue == null || !Number.isFinite(targetValue)) {
      return;
    }
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    setDisplayedValue((current) => {
      if (current == null || !Number.isFinite(current)) {
        return targetValue;
      }
      return current;
    });
    const startValue = displayedValueRef.current != null && Number.isFinite(displayedValueRef.current)
      ? displayedValueRef.current
      : targetValue;
    if (Math.abs(startValue - targetValue) < 0.0001) {
      setDisplayedValue(targetValue);
      return;
    }
    const startedAt = performance.now();
    const durationMs = 525;
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextValue = startValue + (targetValue - startValue) * eased;
      displayedValueRef.current = nextValue;
      setDisplayedValue(nextValue);
      if (progress < 1) {
        animationFrameRef.current = window.requestAnimationFrame(step);
      } else {
        animationFrameRef.current = null;
      }
    };
    animationFrameRef.current = window.requestAnimationFrame(step);
  }, [targetValue]);

  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  return displayedValue;
}
