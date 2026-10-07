import { Redirect } from 'expo-router';
import { HOME_ROUTE } from '../src/services/homeRoute';

export default function IndexScreen() {
  return <Redirect href={HOME_ROUTE as any} />;
}
