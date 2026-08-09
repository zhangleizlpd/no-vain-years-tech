// Phone number masking for display (账号与安全 / phone detail).
// E.164-style: keep country code + first 3 local digits + 4+ stars + last 4 digits.
//
// Country codes matched by longest-prefix first to avoid the "+86138..." hazard
// where "+86" could be mis-parsed as "+861". Extend COUNTRY_CODES when a new
// market is added; the list is ordered longest-first so no sorting is needed.

const COUNTRY_CODES = ['+852', '+886', '+86', '+44', '+81', '+82', '+1', '+7'] as const;

export function maskPhone(phone: string | null): string {
  if (phone === null || phone === '') return '未绑定';

  const countryCode = COUNTRY_CODES.find((cc) => phone.startsWith(cc));
  if (!countryCode) return '未绑定';

  const localNumber = phone.slice(countryCode.length);
  if (!/^\d+$/.test(localNumber) || localNumber.length < 7) return '未绑定';

  const head = localNumber.slice(0, 3);
  const tail = localNumber.slice(-4);
  const middleLen = localNumber.length - 7; // digits between head and tail
  const middle = '*'.repeat(Math.max(middleLen, 4)); // always at least 4 stars

  return `${countryCode} ${head}${middle}${tail}`;
}
