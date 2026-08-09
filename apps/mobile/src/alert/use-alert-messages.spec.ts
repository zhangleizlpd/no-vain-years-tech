import { describe, expect, it, vi } from 'vitest';

vi.mock('@nvy/api-client', () => ({
  useAlertMessagesControllerList: vi.fn(),
  useAlertMessagesControllerUnreadCount: vi.fn(),
  useAlertMessagesControllerMarkRead: vi.fn(),
  getAlertMessagesControllerListQueryKey: vi.fn(() => ['/v1/alert/messages']),
  getAlertMessagesControllerUnreadCountQueryKey: vi.fn(() => ['/v1/alert/messages/unread-count']),
}));

import { unreadBadgeVisible } from './use-alert-messages';

describe('unreadBadgeVisible — 未读角标显隐派生（FR-M07）', () => {
  it('>0 → 显示', () => {
    expect(unreadBadgeVisible(1)).toBe(true);
    expect(unreadBadgeVisible(99)).toBe(true);
  });

  it('0 / 未就位 → 隐藏', () => {
    expect(unreadBadgeVisible(0)).toBe(false);
    expect(unreadBadgeVisible(undefined)).toBe(false);
  });
});
