/**
 * 租约可见性超时 (秒)。poll claim / ack 续租均设 lease_expires_at = now() + 此值;
 * 超时未 result/ack 则事件重新 claimable (重投递, mirror SQS visibility timeout)。
 */
export const LEASE_SECONDS = 300;
