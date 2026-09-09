/**
 * Screenshot-harness bootstrap (spec: pentacle-mobile mock screenshot harness).
 *
 * `installScreenshotHarness()` flips the pentacleStream module into offline
 * mode, seeds a fully-populated default fixture so the first paint isn't empty,
 * and installs `window.__pentacleHarness` so the Playwright driver can re-seed
 * per (screen, variant) and read a readiness flag.
 *
 * It is invoked once at module scope from app/_layout.tsx, strictly gated on
 * EXPO_PUBLIC_SCREENSHOT_HARNESS === '1', so production bundles dead-code the
 * entire path (the require() is never reached and metro tree-shakes it).
 */
import {
  harnessSeedSnapshot,
  harnessSetOffline,
} from "../services/pentacleStream";
import { DEFAULT_FIXTURE, getFixture } from "./screenshotFixtures";
import { harnessSeedReports } from "../services/pentacleAssets";

type PentacleHarnessApi = {
  seed: (screen: string, variant: string) => boolean;
  markReady: () => void;
  ready: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __pentacleHarness: PentacleHarnessApi | undefined;
}

let installed = false;

export function installScreenshotHarness() {
  if (installed) return;
  installed = true;

  harnessSetOffline(true);
  // Seed a default combined fixture so the first paint of any route is
  // populated rather than empty/loading.
  const defaultFixtureKey = process.env.EXPO_PUBLIC_SCREENSHOT_HARNESS_DEFAULT;
  const [defaultScreen, defaultVariant] = String(defaultFixtureKey || "").split(
    ":",
    2,
  );
  const defaultFixture =
    defaultScreen && defaultVariant
      ? getFixture(defaultScreen, defaultVariant) || DEFAULT_FIXTURE
      : DEFAULT_FIXTURE;
  harnessSeedSnapshot(defaultFixture.snapshot, defaultFixture.opts);
  harnessSeedReports(
    defaultFixture.assets?.streamId || "",
    defaultFixture.assets?.reports,
    defaultFixture.assets?.comments,
    defaultFixture.assets?.closed,
    defaultFixture.assets?.error,
    defaultFixture.assets?.loading,
  );

  const api: PentacleHarnessApi = {
    ready: false,
    seed(screen: string, variant: string) {
      const fixture = getFixture(screen, variant);
      if (!fixture) {
        // eslint-disable-next-line no-console
        console.warn(
          `[screenshot-harness] no fixture for ${screen}:${variant}`,
        );
        return false;
      }
      harnessSeedSnapshot(fixture.snapshot, fixture.opts);
      harnessSeedReports(
        fixture.assets?.streamId || "",
        fixture.assets?.reports,
        fixture.assets?.comments,
        fixture.assets?.closed,
        fixture.assets?.error,
        fixture.assets?.loading,
      );
      return true;
    },
    markReady() {
      this.ready = true;
    },
  };

  if (typeof window !== "undefined") {
    window.__pentacleHarness = api;
  }
}
