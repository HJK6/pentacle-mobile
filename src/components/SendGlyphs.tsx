import React from 'react';
import Svg, { G, Path } from 'react-native-svg';

type SendIconProps = { color: string; size?: number };

// Composer SEND icons (design_handoff_send_and_sending). The PRIMARY mark is the
// wand-cast glyph; the crescent-dart is a cleaner geometric alternate kept ready
// to swap in. To switch, change the icon rendered in the composer send button.

// Primary — wand with a sparkle tip and three cast-lines streaming right.
// Source: send-wand-cast.svg (24×24, currentColor).
export function WandCastSendIcon({ color, size = 20 }: SendIconProps) {
  return (
    <Svg testID="send-icon-wand" width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M3.5 19 11 11.6" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      <Path
        d="M12.2 8.4c.42 2 .64 2.22 2.64 2.64-2 .42-2.22.64-2.64 2.64-.42-2-.64-2.22-2.64-2.64 2-.42 2.22-.64 2.64-2.64Z"
        fill={color}
      />
      <G stroke={color} strokeWidth={1.5} strokeLinecap="round">
        <Path d="M16.5 9.2h2.8" />
        <Path d="M17 12h4" />
        <Path d="M16.7 14.7h2.4" />
      </G>
    </Svg>
  );
}

// Backup — minimal rightward dart with a concave crescent tail.
// Source: send-crescent-dart.svg (24×24, currentColor, filled). Swap into the
// composer send button in place of <WandCastSendIcon /> for a quieter mark.
export function CrescentDartSendIcon({ color, size = 20 }: SendIconProps) {
  return (
    <Svg testID="send-icon-crescent" width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 4 21 12 4 20 Q11 12 4 4 Z" fill={color} />
    </Svg>
  );
}
