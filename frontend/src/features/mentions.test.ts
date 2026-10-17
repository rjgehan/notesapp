import { describe, expect, it } from 'vitest';
import { MockVault } from '../api/mock/vault';
import { DocumentSession } from '../sync/DocumentSession';
import { fakeApi, sessionDeps } from '../test/fakes';
import { buildLinkIndex } from './links';
import { linkMentionInSession, mentionLink } from './mentions';

describe('mentionLink (API.md §15.5 step 4)', () => {
  const index = buildLinkIndex(['Welcome.md', 'Plan.md', 'Projects/Plan.md', 'Ideas/Plan B.md']);

  it('writes [[text]] when the link text equals the mention, else [[text|mention]]', () => {
    expect(mentionLink('Ideas/Plan B.md', 'Welcome.md', 'Plan B', 'shortest', 'wiki', index)).toBe('[[Plan B]]');
    expect(mentionLink('Ideas/Plan B.md', 'Welcome.md', 'plan b', 'shortest', 'wiki', index)).toBe('[[Plan B|plan b]]');
    expect(mentionLink('Projects/Plan.md', 'Welcome.md', 'Plan', 'shortest', 'wiki', index)).toBe('[[Projects/Plan|Plan]]');
  });

  it('writes [mention](encoded path) in Markdown style', () => {
    expect(mentionLink('Ideas/Plan B.md', 'Welcome.md', 'plan b', 'shortest', 'markdown', index)).toBe('[plan b](Plan%20B.md)');
  });
});

describe('linkMentionInSession', () => {
  async function open(content: string) {
    const vault = new MockVault(false);
    vault.createFile({ path: 'src.md', content }, 'other-device-1');
    const session = new DocumentSession('src.md', sessionDeps(fakeApi(vault).api));
    await session.ready;
    return { vault, session, version: vault.readFile('src.md').version };
  }

  it('maps server offsets of a CRLF note to the LF document and splices the link', async () => {
    const content = 'Intro\r\nSee the plan b here.\r\nPlan B again\r\n';
    const { session, version } = await open(content);
    // Server offsets count each \r\n as two code units.
    const from = content.indexOf('Plan B');
    const to = from + 'Plan B'.length;
    expect(linkMentionInSession(session, version, { from, to, matched: 'Plan B' }, '[[Plan B]]')).toBe('linked');
    expect(session.getText()).toBe('Intro\nSee the plan b here.\n[[Plan B]] again\n');
    expect(session.getSnapshot().eol).toBe('crlf');
    session.dispose();
  });

  it('links a mention in a note with mixed line endings through the server text (FE-15)', async () => {
    const content = 'first line\r\nsecond line\nthird mentions Target here\r\n';
    const { session, version } = await open(content);
    expect(session.getSnapshot().eol).toBe('lf');
    const from = content.indexOf('Target');
    const mention = { from, to: from + 'Target'.length, matched: 'Target' };
    expect(linkMentionInSession(session, version, mention, '[[Target]]', content)).toBe('linked');
    expect(session.getText()).toBe('first line\nsecond line\nthird mentions [[Target]] here\n');
    session.dispose();
  });

  it('is stale when the version or the text at the offsets differs', async () => {
    const { session, version } = await open('a Plan B b');
    expect(linkMentionInSession(session, 'other-version', { from: 2, to: 8, matched: 'Plan B' }, '[[Plan B]]')).toBe('stale');
    expect(linkMentionInSession(session, version, { from: 0, to: 6, matched: 'Plan B' }, '[[Plan B]]')).toBe('stale');
    expect(session.getText()).toBe('a Plan B b');
    session.dispose();
  });
});
