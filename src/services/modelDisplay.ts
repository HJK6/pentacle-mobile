const MODEL_ID_PATTERN = /^(?:claude|gpt)-([a-z0-9]+(?:[.-][a-z0-9]+)*)$/;

function titleCaseSegment(segment: string) {
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

export function modelDisplayName(modelId: string) {
  const match = MODEL_ID_PATTERN.exec(modelId);
  if (!match) return modelId.trim() || 'Unknown model';

  return match[1].split('-').reduce<string[]>((segments, segment) => {
    if (/^\d+$/.test(segment) && /^\d+(?:\.\d+)*$/.test(segments.at(-1) || '')) {
      segments[segments.length - 1] = `${segments.at(-1)}.${segment}`;
    } else {
      segments.push(titleCaseSegment(segment));
    }
    return segments;
  }, []).join(' ');
}
