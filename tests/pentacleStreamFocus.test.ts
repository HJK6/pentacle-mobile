jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
import {
  __getPentacleStreamSubscriberCountForTests,
  subscribePentacleStreamWhen,
} from '../src/services/pentacleStream';

test('subscribePentacleStreamWhen does not subscribe hidden screens', () => {
  const before = __getPentacleStreamSubscriberCountForTests();
  const unsubscribe = subscribePentacleStreamWhen(false, () => undefined);

  expect(__getPentacleStreamSubscriberCountForTests()).toBe(before);

  unsubscribe();
  expect(__getPentacleStreamSubscriberCountForTests()).toBe(before);
});

test('subscribePentacleStreamWhen releases focused screen subscriptions', () => {
  const before = __getPentacleStreamSubscriberCountForTests();
  const unsubscribe = subscribePentacleStreamWhen(true, () => undefined);

  expect(__getPentacleStreamSubscriberCountForTests()).toBe(before + 1);

  unsubscribe();
  expect(__getPentacleStreamSubscriberCountForTests()).toBe(before);
});
