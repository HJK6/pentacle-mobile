import React, { createContext } from 'react';
import { getMachineHostCount } from '../config/local';
import { usePentacleStreamSelector } from '../services/pentacleStream';

// One roster subscription updates every badge, even on a filtered chat screen.
export const MachineRosterContext = createContext<{ hostCount: number; singleHostCondition?: boolean } | undefined>(undefined);

export function MachineRosterProvider({ children }: { children: React.ReactNode }) {
  const hostCount = usePentacleStreamSelector(getMachineHostCount);
  return <MachineRosterContext.Provider value={{ hostCount }}>{children}</MachineRosterContext.Provider>;
}
