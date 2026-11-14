import React, { useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View, type GestureResponderEvent } from 'react-native';

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };
export type Layer<T> = { key: number; value: T; origin: Point | null; animateIn: boolean };
type Transition = { kind: 'push' | 'pop'; under: number; over: number };
type Ghost = { key: number; node: React.ReactNode; from: Box; to?: Box };
const EASE = Easing.bezier(0.2, 0.8, 0.2, 1);

/** Reads a view's window box; resolves null when the platform cannot measure. */
export function measureBox(ref: React.RefObject<View | null>, done: (box: Box | null) => void) {
  const node = ref.current as unknown as { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void } | null;
  if (typeof node?.measureInWindow !== 'function') return done(null);
  node.measureInWindow((x, y, width, height) => done(Number.isFinite(x) && width > 0 ? { x, y, width, height } : null));
}
export const tapPoint = (event?: GestureResponderEvent): Point | null =>
  event && Number.isFinite(event.nativeEvent?.pageX) ? { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY } : null;

/**
 * Screens are a stack. Opening scales the screen underneath toward the tapped point while the new one grows from it;
 * going back reverses it. A new open or back during a transition settles the running one first, so exactly one
 * interactive screen is ever on top. With reduce motion on, or before it is known, screens simply replace each other.
 */
export function useScreenStack<T>(root: T, reduceMotion: boolean | null) {
  const nextKey = useRef(1), token = useRef(0), offset = useRef<Point>({ x: 0, y: 0 });
  const layersRef = useRef<Layer<T>[]>([{ key: 0, value: root, origin: null, animateIn: false }]);
  const [layers, setLayers] = useState(layersRef.current);
  const [leaving, setLeaving] = useState<Layer<T> | null>(null);
  const [transition, setTransition] = useState<Transition | null>(null);
  const [ghost, setGhostState] = useState<Ghost | null>(null);
  const ghostRef = useRef<Ghost | null>(null);
  const setGhost = (next: Ghost | null) => { ghostRef.current = next; setGhostState(next); };
  const progress = useRef(new Animated.Value(1)).current, flight = useRef(new Animated.Value(1)).current;
  const animate = reduceMotion === false;
  const commit = (next: Layer<T>[]) => { layersRef.current = next; setLayers(next); };
  const settle = () => { token.current += 1; progress.stopAnimation(); progress.setValue(1); flight.stopAnimation(); setLeaving(null); setTransition(null); setGhost(null); };
  const local = (point: Point | null) => point && { x: point.x - offset.current.x, y: point.y - offset.current.y };
  const push = (value: T, event?: GestureResponderEvent, hero?: { node: React.ReactNode; ref: React.RefObject<View | null> }) => {
    settle();
    const under = layersRef.current[layersRef.current.length - 1];
    const layer: Layer<T> = { key: nextKey.current++, value, origin: local(tapPoint(event)), animateIn: animate };
    commit([...layersRef.current, layer]);
    if (!animate) return;
    const mine = token.current;
    setTransition({ kind: 'push', under: under.key, over: layer.key });
    progress.setValue(0);
    Animated.timing(progress, { toValue: 1, duration: 430, easing: EASE, useNativeDriver: true })
      .start(() => { if (token.current === mine) setTransition(null); });
    if (hero) measureBox(hero.ref, from => { if (from && token.current === mine) setGhost({ key: layer.key, node: hero.node, from }); });
  };
  const popTo = (keep: number) => {
    const current = layersRef.current;
    if (keep < 1 || keep >= current.length) return;
    settle();
    const over = current[current.length - 1];
    commit(current.slice(0, keep));
    if (!animate) return;
    const mine = token.current;
    setLeaving(over);
    setTransition({ kind: 'pop', under: layersRef.current[keep - 1].key, over: over.key });
    progress.setValue(1);
    Animated.timing(progress, { toValue: 0, duration: 340, easing: EASE, useNativeDriver: true })
      .start(() => { if (token.current === mine) { setLeaving(null); setTransition(null); } });
  };
  const pop = () => popTo(layersRef.current.length - 1);
  const reset = (value: T) => { settle(); commit([{ key: nextKey.current++, value, origin: null, animateIn: false }]); };
  /** The new header reports where its hero sits; the tapped icon then flies there. */
  const heroAt = (key: number, to: Box) => {
    const current = ghostRef.current;
    if (!current || current.key !== key || current.to) return;
    const mine = token.current;
    flight.setValue(0);
    setGhost({ ...current, to });
    Animated.timing(flight, { toValue: 1, duration: 460, easing: EASE, useNativeDriver: true })
      .start(() => { if (token.current === mine) setGhost(null); });
  };
  const top = layers[layers.length - 1];
  return { layers, leaving, transition, ghost, progress, flight, top, push, pop, popTo, reset, heroAt, offset };
}

export function StackView<T>({ stack, render }: {
  stack: ReturnType<typeof useScreenStack<T>>;
  render(layer: Layer<T>, state: { top: boolean; heroHidden: boolean }): React.ReactNode;
}) {
  const { layers, leaving, transition, ghost, progress, flight, top, offset } = stack;
  const all = leaving ? [...layers, leaving] : layers;
  const box = useRef<View>(null);
  const originOf = (key: number) => all.find(layer => layer.key === key)?.origin;
  return <View ref={box} style={StyleSheet.absoluteFill} onLayout={() => measureBox(box, b => { if (b) offset.current = { x: b.x, y: b.y }; })}>
    {all.map(layer => {
      const isTop = layer.key === top.key && layer !== leaving;
      const role = transition?.under === layer.key ? 'under' : transition?.over === layer.key ? 'over' : null;
      const origin = transition ? originOf(transition.over) : null;
      const motion = role && origin ? { transformOrigin: [origin.x, origin.y, 0] } : {};
      const style = role === 'under'
        ? { opacity: progress.interpolate({ inputRange: [0, 0.65, 1], outputRange: [1, 0, 0] }), transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] }) }] }
        : role === 'over' ? { opacity: progress.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1] }), transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) }] }
          : null;
      const shown = isTop || role !== null;
      return <Animated.View key={layer.key} testID={shown ? `lanes-layer-${isTop ? 'top' : role}` : undefined} pointerEvents={isTop ? 'auto' : 'none'}
        accessibilityElementsHidden={!isTop} importantForAccessibility={isTop ? 'auto' : 'no-hide-descendants'}
        style={[StyleSheet.absoluteFill, shown ? null : { display: 'none' }, style, motion]}>
        {render(layer, { top: isTop, heroHidden: ghost?.key === layer.key && !!ghost.to })}
      </Animated.View>;
    })}
    {ghost?.to ? <Animated.View testID="lanes-hero-flight" pointerEvents="none" style={{
      position: 'absolute', left: ghost.to.x - offset.current.x, top: ghost.to.y - offset.current.y, width: ghost.to.width, height: ghost.to.height,
      alignItems: 'center', justifyContent: 'center', transform: [
        { translateX: flight.interpolate({ inputRange: [0, 1], outputRange: [ghost.from.x + ghost.from.width / 2 - ghost.to.x - ghost.to.width / 2, 0] }) },
        { translateY: flight.interpolate({ inputRange: [0, 1], outputRange: [ghost.from.y + ghost.from.height / 2 - ghost.to.y - ghost.to.height / 2, 0] }) },
        { scale: flight.interpolate({ inputRange: [0, 1], outputRange: [ghost.from.width / ghost.to.width, 1] }) },
      ] }}>{ghost.node}</Animated.View> : null}
  </View>;
}
