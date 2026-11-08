import React, { useEffect, useRef } from "react";
import { Animated, Pressable, View } from "react-native";
import { PanGestureHandler, State } from "react-native-gesture-handler";
import { p } from "./LaneAtoms";

export type SheetSnap = "peek" | "full";
export default function LanesSheet({
  height,
  snap,
  onSnap,
  children,
}: {
  height: number;
  snap: SheetSnap;
  onSnap(snap: SheetSnap): void;
  children: React.ReactNode;
}) {
  const position = useRef(new Animated.Value(height * 0.6)).current;
  const origin = useRef(height * 0.6);
  useEffect(() => {
    const animation = Animated.timing(position, {
      toValue: snap === "peek" ? height * 0.6 : 0,
      duration: 240,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [height, snap, position]);
  return (
    <Animated.View
      testID="lanes-sheet"
      accessibilityValue={{ text: snap === "peek" ? "40%" : "full" }}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height,
        backgroundColor: p.ink,
        borderColor: `${p.green}55`,
        borderWidth: 1,
        borderTopLeftRadius: 22,
        borderTopRightRadius: 22,
        overflow: "hidden",
        transform: [{ translateY: position }],
      }}
    >
      <PanGestureHandler
        onGestureEvent={(event) =>
          position.setValue(
            Math.max(
              0,
              Math.min(
                height * 0.6,
                origin.current + event.nativeEvent.translationY,
              ),
            ),
          )
        }
        onHandlerStateChange={(event) => {
          if (event.nativeEvent.state === State.BEGAN)
            position.stopAnimation((value) => {
              origin.current = value;
            });
          if (event.nativeEvent.oldState === State.ACTIVE) {
            const { translationY, velocityY } = event.nativeEvent;
            const next =
              velocityY < -400
                ? "full"
                : velocityY > 400
                  ? "peek"
                  : origin.current + translationY < height * 0.3
                    ? "full"
                    : "peek";
            // A gesture that lands on the same snap must still settle the animated value.
            Animated.timing(position, {
              toValue: next === "full" ? 0 : height * 0.6,
              duration: 240,
              useNativeDriver: true,
            }).start();
            onSnap(next);
          }
        }}
      >
        <View collapsable={false}>
          <Pressable
            testID="lanes-sheet-handle"
            accessibilityRole="adjustable"
            accessibilityLabel="Lane list height"
            accessibilityValue={{ text: snap === "peek" ? "40%" : "full" }}
            accessibilityActions={[
              { name: "increment", label: "Expand" },
              { name: "decrement", label: "Collapse" },
            ]}
            onAccessibilityAction={(event) =>
              onSnap(
                event.nativeEvent.actionName === "increment" ? "full" : "peek",
              )
            }
            onPress={() => onSnap(snap === "peek" ? "full" : "peek")}
            style={{
              height: 26,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <View
              style={{
                width: 56,
                height: 4,
                borderRadius: 2,
                backgroundColor: `${p.green}55`,
              }}
            />
          </Pressable>
        </View>
      </PanGestureHandler>
      {children}
    </Animated.View>
  );
}
