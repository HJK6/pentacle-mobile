// The six operator-only household verbs over the shared RPC wrapper (contracts § Household RPC).
// Each call builds its payload from named fields only, so `scope`, `priority`, `due_date` or
// `created_by` can never be forwarded: Cosmo keeps app-created rows private to the operator.
import { sendHouseholdCommand } from '../pentacleStream';
import type { HouseholdEvent, HouseholdItem, HouseholdSnapshot, ListId, NewEvent } from './types';

type Frame<T> = T & { type: string; server_now?: string };

export function snapshot(month?: string): Promise<Frame<HouseholdSnapshot>> {
  return sendHouseholdCommand('household.snapshot', month === undefined ? {} : { month });
}

export function addItem(list: ListId, label: string): Promise<Frame<{ item: HouseholdItem }>> {
  return sendHouseholdCommand('household.item.add', { list, label });
}

export function doneItem(itemId: number): Promise<Frame<{ item: HouseholdItem }>> {
  return sendHouseholdCommand('household.item.done', { item_id: itemId });
}

export function removeItem(itemId: number): Promise<Frame<{ item_id: number }>> {
  return sendHouseholdCommand('household.item.remove', { item_id: itemId });
}

export function addEvent(value: NewEvent): Promise<Frame<{ event: HouseholdEvent }>> {
  return sendHouseholdCommand('household.event.add', {
    date: value.date,
    time: value.time,
    title: value.title,
    who: value.who,
  });
}

export function removeEvent(eventId: number): Promise<Frame<{ event_id: number }>> {
  return sendHouseholdCommand('household.event.remove', { event_id: eventId });
}
