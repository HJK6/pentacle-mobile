import React, { memo, useMemo, useState } from 'react';
import {
  LayoutChangeEvent,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Spacing, Tokens } from '@/constants/Colors';

type Props = {
  children?: React.ReactNode;
  cut?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
};

export default function Bevel({
  children,
  cut = Spacing.bevelCard,
  fill = Tokens.palette.panel,
  stroke = Tokens.palette.line,
  strokeWidth = 1,
  style,
  contentStyle,
}: Props) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  const path = useMemo(() => {
    const width = Math.max(0, size.width);
    const height = Math.max(0, size.height);
    const bevel = Math.min(cut, width / 2, height / 2);
    if (!width || !height) return '';
    return `M0 0 H${width - bevel} L${width} ${bevel} V${height} H${bevel} L0 ${height - bevel} Z`;
  }, [cut, size.height, size.width]);

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) =>
      current.width === width && current.height === height ? current : { width, height },
    );
  };

  return (
    <View onLayout={handleLayout} style={[styles.root, style]}>
      <BevelFrame
        width={size.width}
        height={size.height}
        path={path}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
      <View style={[styles.content, contentStyle]}>{children}</View>
    </View>
  );
}

// Memoized SVG frame: the bevel Path depends only on layout size + fill/stroke,
// none of which change on a message update. Splitting it out of Bevel's render
// lets the per-row SVG reconcile be skipped under burst load (only the volatile
// text children re-render), the same isolation slice 2b applied to the row's
// other SVG leaves (spec tap_shell_layout_regression_build_1155 slice 3).
type BevelFrameProps = {
  width: number;
  height: number;
  path: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
};

export const BevelFrame = memo(function BevelFrame({
  width,
  height,
  path,
  fill,
  stroke,
  strokeWidth,
}: BevelFrameProps) {
  if (!path) return null;
  return (
    <Svg pointerEvents="none" width={width} height={height} style={StyleSheet.absoluteFill}>
      <Path d={path} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
    </Svg>
  );
});

const styles = StyleSheet.create({
  root: {
    position: 'relative',
    overflow: 'hidden',
  },
  content: {
    position: 'relative',
    zIndex: 1,
  },
});
