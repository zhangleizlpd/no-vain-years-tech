// Client account number masking for display (券商账户 / broker account row).
//
// Mirrors phone.ts maskPhone range. Mockup maskCust 口径
// (design/handoff-claude-design BrokerFlow.jsx): keep first 4 + '****' + last 4
// only when the number is long enough to mask (> 8 chars); shorter numbers stay
// raw (too few digits to meaningfully hide). Default account rows carry no client
// number (null) and never render a masked value — null is the defensive path.

export function maskClientNo(clientNo: string | null): string {
  if (clientNo === null || clientNo === '') return '';
  if (clientNo.length <= 8) return clientNo;
  return `${clientNo.slice(0, 4)}****${clientNo.slice(-4)}`;
}
