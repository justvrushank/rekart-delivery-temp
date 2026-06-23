// Pure, client- and server-safe time formatting for Rekart delivery slots.
// No DB or server-only imports, so route components can use it directly.

/**
 * Format minutes-from-midnight as a 12-hour clock time:
 *   270 -> "04:30 AM", 0 -> "12:00 AM", 720 -> "12:00 PM", 1110 -> "06:30 PM".
 */
export function minutesToTime(minutes: number): string {
  const hours24 = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const period = hours24 < 12 ? "AM" : "PM";
  const hour12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const hh = String(hour12).padStart(2, "0");
  const mm = String(mins).padStart(2, "0");
  return `${hh}:${mm} ${period}`;
}
