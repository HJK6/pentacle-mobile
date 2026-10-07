// Wire shapes of the operator-only `household.*` daemon verbs, which proxy the Cosmo household
// store (spec_pentacle_mobile__personal_screens_2026_10 § B2). Cosmo is the only store: these
// are Cosmo rows as the operator's credential sees them (operator-private + shared), translated by
// the daemon into neutral, viewer-relative values: no household member's name crosses the wire.

export type ListId = 'tasks' | 'grocery' | 'meals' | 'chores' | 'study';
/** `private`: visible to the operator only; `shared`: both household members. */
export type Scope = 'private' | 'shared';
/** `assistant` is the operator's assistant; `partner_assistant` the other member's. */
export type CreatedBy = 'app' | 'assistant' | 'partner_assistant';
/** Viewer-relative `who`; display only, never visibility. */
export type Who = 'self' | 'partner' | 'both';

export type HouseholdItem = {
  id: number;
  list: ListId;
  label: string;
  priority: 'hi' | 'med' | 'lo';
  due_date: string | null;
  position: number;
  category: string | null;
  scope: Scope;
  created_by: CreatedBy;
  done_at: string | null;
  routine_id: number | null;
};

export type HouseholdEvent = {
  id: number;
  date: string;
  time: string | null;
  title: string;
  who: Who;
  location: string | null;
  star: boolean;
  scope: Scope;
  created_by: CreatedBy;
};

export type HouseholdSnapshot = {
  /** America/Chicago calendar day computed by the daemon; every day rule derives from it. */
  today: string;
  month?: string;
  lists: Record<ListId, HouseholdItem[]>;
  events: HouseholdEvent[];
  server_now: string;
  /** Display name of the other household member (runtime config on the daemon). */
  people?: { partner?: string };
};

export type NewEvent = { date: string; time: string | null; title: string; who: Who };
