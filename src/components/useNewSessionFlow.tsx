import React, { useCallback, useRef, useState } from 'react';
import { Alert } from 'react-native';
import SummonModal, { type SummonMachine } from './SummonModal';
import { usePentacleStreamActions, type SpawnCatalog, type SpawnProvider } from '../services/pentacleStream';
import { validateSpawnCatalog } from '../services/spawnCatalog';
import { createSpawnIntentKeeper, executeSpawnIntent } from '../services/spawnIntent';

type SpawnSelection = {
  provider: SpawnProvider;
  model: string;
  effort: string;
  resolutionSource: 'profile_default' | 'explicit_override';
  objective?: string;
};

// The one new-session flow (summon sheet, spawn catalog, idempotent spawn intent). Shared by
// the Chats + button and the Bart home drawer's + button (docs/bart_home_contracts.md).
// The caller renders `modal` once and calls `start()`; a spawned session is handed to `onOpened`.
export function useNewSessionFlow({ machines, onOpened }: {
  machines: SummonMachine[];
  onOpened: (streamId: string) => void;
}) {
  const actions = usePentacleStreamActions();
  const [spawning, setSpawning] = useState<{ host: string; provider: SpawnProvider } | null>(null);
  const [summonVisible, setSummonVisible] = useState(false);
  const [spawnCatalog, setSpawnCatalog] = useState<SpawnCatalog | null>(null);
  const [spawnCatalogLoading, setSpawnCatalogLoading] = useState(false);
  const [spawnCatalogError, setSpawnCatalogError] = useState<string | null>(null);
  const [spawnSubmitError, setSpawnSubmitError] = useState<string | null>(null);
  const spawnCatalogRequestRef = useRef(0);
  const spawnCatalogConflictRefreshedRef = useRef(false);
  // `spawning` is React state, so it is stale for every tap that lands before its commit — which
  // is exactly the window the slow chats re-render opens. The synchronous ref is the guard that
  // actually holds; the state stays for rendering.
  // spec_example_2026_01.
  const spawnInFlightRef = useRef(false);
  const spawnIntentKeeperRef = useRef(createSpawnIntentKeeper());
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;
  const activeMachines = machines.filter((machine) => machine.online);

  const loadSpawnCatalog = useCallback(async () => {
    const request = ++spawnCatalogRequestRef.current;
    setSpawnCatalogLoading(true);
    setSpawnCatalogError(null);
    try {
      const catalog = validateSpawnCatalog(await actions.getSpawnCatalog());
      if (request !== spawnCatalogRequestRef.current) return;
      setSpawnCatalog(catalog);
    } catch (error) {
      if (request !== spawnCatalogRequestRef.current) return;
      setSpawnCatalog(null);
      setSpawnCatalogError(error instanceof Error ? error.message : 'Spawn catalog unavailable.');
    } finally {
      if (request === spawnCatalogRequestRef.current) setSpawnCatalogLoading(false);
    }
  }, [actions]);

  const handleSpawn = async (host: string, selection: SpawnSelection) => {
    if (!spawnCatalog || spawnInFlightRef.current) return;
    spawnInFlightRef.current = true;
    const intentSelection = {
      host,
      provider: selection.provider,
      model: selection.model,
      effort: selection.effort,
      catalogVersion: spawnCatalog.catalog_version,
    };
    try {
      const result = await executeSpawnIntent(
        spawnIntentKeeperRef.current,
        intentSelection,
        (idempotencyKey) => {
          setSpawnSubmitError(null);
          setSpawning({ host, provider: selection.provider });
          return actions.spawnSessionV2({
            host,
            provider: selection.provider,
            model: selection.model,
            effort: selection.effort,
            spawnProfile: 'desktop_manual',
            catalogVersion: spawnCatalog.catalog_version,
            resolutionSource: selection.resolutionSource,
            // Top-level operator spawn: no objective; the daemon derives it. Serializer
            // omits the key when this is undefined.
            objective: selection.objective,
            idempotencyKey,
          });
        },
      );
      setSummonVisible(false);
      onOpenedRef.current(result.session.stream_id);
    } catch (error) {
      // A daemon-answered rejection is safe to retry under a fresh id; a transport or
      // indeterminate failure is not, because the chat may already exist.
      const message = error instanceof Error ? error.message : 'Failed to start session';
      setSpawnSubmitError(message);
      if ((error as { errorCode?: string })?.errorCode === 'spawn_catalog_version_conflict') {
        setSpawnCatalog(null);
        if (!spawnCatalogConflictRefreshedRef.current) {
          spawnCatalogConflictRefreshedRef.current = true;
          void loadSpawnCatalog();
        }
      }
    } finally {
      spawnInFlightRef.current = false;
      setSpawning(null);
    }
  };

  const start = () => {
    if (spawnInFlightRef.current) return;
    spawnIntentKeeperRef.current.reset();
    if (!activeMachines.length) {
      Alert.alert('Pentacle', 'No live machines are available.');
      return;
    }
    spawnCatalogConflictRefreshedRef.current = false;
    setSpawnSubmitError(null);
    setSummonVisible(true);
    void loadSpawnCatalog();
  };

  const modal = (
    <SummonModal
      visible={summonVisible}
      machines={machines}
      catalog={spawnCatalog}
      catalogLoading={spawnCatalogLoading}
      catalogError={spawnCatalogError}
      submitting={spawning !== null}
      submitError={spawnSubmitError}
      onRetryCatalog={() => {
        spawnCatalogConflictRefreshedRef.current = false;
        void loadSpawnCatalog();
      }}
      onClose={() => {
        if (spawning) return;
        spawnCatalogRequestRef.current += 1;
        spawnIntentKeeperRef.current.reset();
        setSummonVisible(false);
      }}
      onPick={handleSpawn}
    />
  );

  return {
    start,
    spawning,
    canStart: Boolean(activeMachines.length && spawning === null),
    modal,
  };
}
