import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";

/** Null until the OS preference is known, so nothing moves before it is read. */
export function useReduceMotion() {
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  useEffect(() => {
    let current = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (current) setReduceMotion(value);
      })
      .catch(() => {
        if (current) setReduceMotion(true);
      });
    const listener = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    return () => {
      current = false;
      listener?.remove();
    };
  }, []);
  return reduceMotion;
}

/** One native loop per screen; every working mark on that screen reads the same phase. */
export function useWorkingMotion(active: boolean, hasWorking: boolean, duration = 2000) {
  const phase = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReduceMotion();
  const moving = active && hasWorking && reduceMotion === false;
  useEffect(() => {
    if (!moving) {
      phase.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.timing(phase, {
        toValue: 1,
        duration,
        easing: Easing.linear,
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [phase, moving, duration]);
  return { phase, moving };
}
