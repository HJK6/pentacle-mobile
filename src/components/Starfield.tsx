import React, { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Tokens } from '@/constants/Colors';

type Star = {
  x: number;
  y: number;
  r: number;
  o: number;
};

function makeStars(n = 44, seed = 7): Star[] {
  let s = seed;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  return Array.from({ length: n }, () => ({
    x: rnd() * 100,
    y: rnd() * 100,
    r: 0.7 + rnd() * 1.8,
    o: 0.14 + rnd() * 0.45,
  }));
}

const DEFAULT_STARS = makeStars();

function Starfield({ n = 44, seed = 7 }: { n?: number; seed?: number }) {
  const stars = n === 44 && seed === 7 ? DEFAULT_STARS : makeStars(n, seed);

  return (
    <View pointerEvents="none" style={styles.root}>
      {stars.map((star, index) => (
        <View
          key={`${index}-${star.x.toFixed(3)}`}
          style={[
            styles.star,
            {
              left: `${star.x}%`,
              top: `${star.y}%`,
              width: star.r,
              height: star.r,
              borderRadius: star.r / 2,
              opacity: star.o,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  star: {
    position: 'absolute',
    backgroundColor: Tokens.palette.star,
  },
});

export default memo(Starfield);
