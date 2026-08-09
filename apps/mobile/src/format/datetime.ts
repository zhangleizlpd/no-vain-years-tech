export type LastActiveGranularity = 'minute' | 'second';

// Server sends UTC timestamps; display in UTC so output is timezone-invariant.
export function formatLastActive(iso: string, granularity: LastActiveGranularity): string {
  const d = new Date(iso);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  if (granularity === 'minute') return `${yyyy}.${mm}.${dd} ${hh}:${min}`;
  const sec = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}.${mm}.${dd} ${hh}:${min}:${sec}`;
}
