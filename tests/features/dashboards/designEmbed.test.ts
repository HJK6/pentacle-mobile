import {
  createDesignEmbed,
  designDashboardHref,
  isDesignEmbedNavigationAllowed,
} from '../../../src/features/dashboards/designEmbed';
import { parseDashboardLinkEvent } from 'pentacle-chat-core';
import sharedFixtures from '../../../pentacle-chat-core/tests/fixtures/dashboard_links_v1.json';

const policy = {
  pentacleOrigin: 'https://chat.example.ts.net',
  tailnetSuffix: 'example.ts.net',
};
const origin = policy.pentacleOrigin;
const home = '/next/embed/design';

test.each(sharedFixtures.event_cases)('uses the shared embedded route for $name', fixture => {
  const link = parseDashboardLinkEvent(fixture.event);
  expect(link).toEqual(fixture.link);
  if (!link) return;
  const route = designDashboardHref(link.target);
  const source = createDesignEmbed(policy, route.params);
  expect(source).toEqual({ origin, uri: origin + fixture.paths?.embed });
  expect(isDesignEmbedNavigationAllowed(origin, { url: source!.uri })).toBe(true);
});

test('maps the provisional E8 exact screen to the native route', () => {
  const params = designDashboardHref({
    project_id: 'delivery',
    design_id: 'delivery-board',
    view_id: 'prototype',
  }).params;
  expect(createDesignEmbed(policy, params)?.uri).toBe(origin + '/next/embed/design/delivery/delivery-board/prototype');
});

test.each([
  [{}, home],
  [{ projectId: 'p', designId: 'design-a' }, `${home}/p/design-a`],
  [{ projectId: 'p', designId: 'design-a', viewId: 'screen-2' }, `${home}/p/design-a/screen-2`],
  [{ projectId: 'a'.repeat(80), designId: '0' }, `${home}/${'a'.repeat(80)}/0`],
])('builds the exact embedded URL for %j', (target, path) => {
  expect(createDesignEmbed(policy, target)).toEqual({ origin, uri: origin + path });
  expect(isDesignEmbedNavigationAllowed(origin, { url: origin + path })).toBe(true);
});

test.each([
  { projectId: 'project' },
  { designId: 'design' },
  { viewId: 'view' },
  { projectId: 'p', designId: 'd', viewId: '' },
  { projectId: 'P', designId: 'd' },
  { projectId: 'p', designId: 'x'.repeat(81) },
  { projectId: ['p'], designId: 'd' },
  { projectId: 'p', designId: 'd/other' },
  { projectId: 'p', designId: 'd\n' },
])('rejects malformed route parameters: %j', target => {
  expect(createDesignEmbed(policy, target)).toBeNull();
});

test.each([
  null,
  { ...policy, tailnetSuffix: 'other.ts.net' },
  { ...policy, pentacleOrigin: 'http://chat.example.ts.net' },
  { ...policy, pentacleOrigin: 'https://name@chat.example.ts.net' },
  { ...policy, pentacleOrigin: 'https://chat.example.ts.net/next/..' },
])('requires a live valid hosted policy: %j', input => {
  expect(createDesignEmbed(input, {})).toBeNull();
});

test.each([
  `${origin}/next/design`,
  `${origin}/login`,
  `${origin}/`,
  `${origin}${home}-other`,
  `${origin}${home}/`,
  `${origin}${home}/p`,
  `${origin}${home}/p/d/v/extra`,
  `${origin}${home}/p/%64`,
  `${origin}${home}/p./d`,
  `${origin}${home}/p/q/../d`,
  `${origin}/next/embed/x/../design/p/d`,
  `${origin}${home}/p/d?v=1`,
  `${origin}${home}/p/d#`,
  `https://chat.example.ts.net:444${home}`,
  `https://another.example.ts.net${home}`,
  `https://chat.example.ts.net.other.example.ts.net${home}`,
  `http://chat.example.ts.net${home}`,
  `https://user@chat.example.ts.net${home}`,
  'about:blank',
  'about:srcdoc',
  'data:text/plain,example',
  'blob:https://chat.example.ts.net/id',
  'javascript:void(0)',
  'tel:5550100',
  'mailto:help@example.test',
  'sms:5550100',
  'example://external',
])('rejects main-frame navigation to %s', url => {
  expect(isDesignEmbedNavigationAllowed(origin, { url })).toBe(false);
});

test('admits opaque prepared frames only as children and refuses new windows', () => {
  expect(isDesignEmbedNavigationAllowed(origin, { url: 'about:srcdoc', isTopFrame: false })).toBe(true);
  expect(isDesignEmbedNavigationAllowed(origin, { url: 'about:blank', isTopFrame: false })).toBe(true);
  expect(isDesignEmbedNavigationAllowed(origin, { url: 'https://elsewhere.example.test/frame', isTopFrame: false })).toBe(false);
  expect(isDesignEmbedNavigationAllowed(origin, { url: origin + home, hasTargetFrame: false })).toBe(false);
});
