// /pentacle/personal/list/[id] — list detail; `id` is the Cosmo list name (contracts § Routes).
import React from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';
import ListDetail from '../../../../src/components/personal/ListDetail';
import { isListId } from '../../../../src/services/household/selectors';

export default function ListDetailRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const listId = typeof id === 'string' ? decodeURIComponent(id) : '';
  if (!isListId(listId)) return <Redirect href="/pentacle/personal/lists" />;
  return <ListDetail listId={listId} />;
}
