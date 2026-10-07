import React from 'react';
import { SessionScreen } from '../pentacle/session/[streamId]';
import { BART_STREAM_ID } from '../../src/components/status/statusSelectors';

export default function BartScreen() {
  return <SessionScreen streamId={BART_STREAM_ID} header={<></>} />;
}
