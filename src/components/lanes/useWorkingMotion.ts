import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";

/** One native loop for the entire constellation; static until OS preference is known. */
export function useWorkingMotion(active: boolean, hasWorking: boolean) {
  const phase = useRef(new Animated.Value(0)).current;
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
  const moving = active && hasWorking && reduceMotion === false;
  useEffect(() => {
    if (!moving) {
      phase.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.timing(phase, {
        toValue: 1,
        duration: 2000,
        easing: Easing.linear,
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [phase, moving]);
  return { phase, moving };
}
