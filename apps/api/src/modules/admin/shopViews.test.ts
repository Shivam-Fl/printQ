import { describe, expect, it, vi } from 'vitest';

const events = vi.hoisted(() => [] as { subjectId: string; metadata: unknown }[]);
vi.mock('../../lib/prisma.js', () => ({ prisma: {
  $disconnect: vi.fn(async () => undefined),
  adminAuditEvent: { findMany: vi.fn(async () => events) },
} }));

const { latestUnpublishReasons, shopListState, shopViewWhere } = await import('./shopViews.js');
const { publishedShopWhere } = await import('../public/discovery.js');

const shop = (verificationStatus: 'draft' | 'submitted' | 'verified' | 'rejected', published: boolean, campus: { isActive: boolean } | null = null) =>
  ({ verificationStatus, publishedAt: published ? new Date() : null, campus });

describe('admin shop views', () => {
  it('names each shop state the way the console shows it', () => {
    expect(shopListState(shop('draft', false))).toBe('setting_up');
    expect(shopListState(shop('submitted', false))).toBe('waiting_review');
    expect(shopListState(shop('rejected', false))).toBe('rejected');
    expect(shopListState(shop('verified', false))).toBe('hidden_by_admin');
    expect(shopListState(shop('verified', true, { isActive: false }))).toBe('campus_inactive');
    expect(shopListState(shop('verified', true, { isActive: true }))).toBe('live');
    expect(shopListState(shop('verified', true))).toBe('live');
  });

  it('uses the public discovery rule for the Live tab and splits the rest into hidden / setting up', () => {
    expect(shopViewWhere('live')).toBe(publishedShopWhere);
    expect(shopViewWhere('all')).toEqual({});
    expect(shopViewWhere('setup')).toEqual({ verificationStatus: { in: ['draft', 'submitted'] } });
    expect(shopViewWhere('hidden')).toEqual({
      OR: [
        { verificationStatus: 'rejected' },
        { verificationStatus: 'verified', publishedAt: null },
        { verificationStatus: 'verified', campus: { is: { isActive: false } } },
      ],
    });
  });

  it('keeps only the newest unpublish reason per shop', async () => {
    events.push(
      { subjectId: 'a', metadata: null },
      { subjectId: 'b', metadata: { reason: 'Spam listing' } },
      { subjectId: 'a', metadata: { reason: 'Older reason' } },
    );
    const reasons = await latestUnpublishReasons(['a', 'b']);
    expect(reasons.get('a')).toBeNull();
    expect(reasons.get('b')).toBe('Spam listing');
    expect((await latestUnpublishReasons([])).size).toBe(0);
  });
});
