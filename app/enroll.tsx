import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { enrollPentacleDevice, enrollPentacleDeviceLegacy } from '../src/services/pentacleStream';

const P = {
  bg: '#07110d',
  panel: '#0f1b16',
  border: '#28463a',
  text: '#eef8f2',
  muted: '#8fa9a0',
  accent: '#7ef0ba',
  danger: '#ff8b7c',
};

export default function PentacleEnrollScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string; ws?: string; protocol?: string }>();
  const code = String(params.code || '').trim().toUpperCase();
  const ws = String(params.ws || '').trim();
  const legacyEnrollment = String(params.protocol || '').trim() === '1';
  const { isReady, setToken, setWsUrl } = usePentacleToken();
  const [status, setStatus] = useState('Preparing secure enrollment…');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isReady) return;
    if (!code) {
      setError('Enrollment link is missing a code.');
      return;
    }
    let active = true;
    const run = async () => {
      try {
        setStatus('Contacting Pentacle control plane…');
        if (ws) {
          await setWsUrl(ws);
        }
        const result = await (legacyEnrollment ? enrollPentacleDeviceLegacy : enrollPentacleDevice)(
          code,
          ws || undefined,
        );
        if (!active) return;
        setStatus('Storing device credential behind Face ID…');
        await setToken(result.token);
        if (!active) return;
        router.replace('/chats' as any);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Enrollment failed');
      }
    };
    run();
    return () => {
      active = false;
    };
  }, [code, isReady, legacyEnrollment, router, setToken, setWsUrl, ws]);

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <ActivityIndicator color={P.accent} />
        <Text style={styles.title}>Pentacle Enrollment</Text>
        <Text style={styles.body}>{error || status}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: P.bg,
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: P.panel,
    borderColor: P.border,
    borderWidth: 1,
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    gap: 14,
  },
  title: {
    color: P.text,
    fontSize: 24,
    fontWeight: '700',
  },
  body: {
    color: P.muted,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
});
