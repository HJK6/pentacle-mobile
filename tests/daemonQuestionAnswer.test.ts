import { buildDaemonQuestionAnswer } from '../src/services/daemonQuestionAnswer';

type AnswerCase = {
  label: string;
  request: {
    type: string;
    request_id: string;
    question_id: string;
    selections?: string[];
    text?: string;
  };
};

const CASES: AnswerCase[] = [
  {
    label: 'single-choice',
    request: {
      type: 'prompt.answer',
      request_id: 'request-1',
      question_id: 'question-1',
      selections: ['option-a'],
    },
  },
  {
    label: 'free-text',
    request: {
      type: 'prompt.answer',
      request_id: 'request-2',
      question_id: 'question-2',
      text: 'A synthetic answer.',
    },
  },
];

describe('buildDaemonQuestionAnswer — canonical prompt.answer messages', () => {
  for (const item of CASES) {
    test(`case ${item.label} serializes to the expected message`, () => {
      const built = buildDaemonQuestionAnswer({
        request_id: item.request.request_id,
        question_id: item.request.question_id,
        selections: item.request.selections,
        text: item.request.text,
      });
      expect(built).toEqual(item.request);
    });
  }

  test('omits empty selections and whitespace-only text', () => {
    expect(buildDaemonQuestionAnswer({
      request_id: 'request-3',
      question_id: 'question-3',
      selections: [],
      text: 'done',
    })).toEqual({
      type: 'prompt.answer',
      request_id: 'request-3',
      question_id: 'question-3',
      text: 'done',
    });
    expect(buildDaemonQuestionAnswer({
      request_id: 'request-4',
      question_id: 'question-4',
      selections: ['option-a'],
      text: '   ',
    })).toEqual({
      type: 'prompt.answer',
      request_id: 'request-4',
      question_id: 'question-4',
      selections: ['option-a'],
    });
  });

  test('never emits alternate text field names', () => {
    const built = buildDaemonQuestionAnswer({
      request_id: 'request-5',
      question_id: 'question-5',
      text: 'free typed',
    }) as Record<string, unknown>;
    expect('custom_text' in built).toBe(false);
    expect('note' in built).toBe(false);
    expect(built.type).toBe('prompt.answer');
  });

  test('rejects an answer with neither selections nor text', () => {
    expect(() => buildDaemonQuestionAnswer({
      request_id: 'request-6',
      question_id: 'question-6',
    })).toThrow();
    expect(() => buildDaemonQuestionAnswer({
      request_id: 'request-7',
      question_id: 'question-7',
      selections: [],
      text: '  ',
    })).toThrow();
  });
});
