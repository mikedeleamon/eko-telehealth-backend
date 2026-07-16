/**
 * Display formatters. The client contracts carry pre-formatted strings
 * (e.g. Conversation.time = "2:03 PM", Doctor.fee = "₦15,000"), so the API
 * returns display-ready values rather than making each client reformat.
 */

export function formatClockTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

/** "2:03 PM" today, "Yesterday", otherwise "Jun 14". */
export function formatConversationTime(d: Date): string {
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return formatClockTime(d);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "just now" / "5m ago" / "2h ago" / "3d ago" / "Jun 14". */
export function formatRelative(d: Date): string {
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "Feb 12, 2026" — used by the admin user table. */
export function formatJoined(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "₦15,000" -> 15000. Returns 0 when there are no digits. */
export function parseAmount(fee: string | null | undefined): number {
  if (!fee) return 0;
  const digits = fee.replace(/[^0-9]/g, '');
  return digits ? parseInt(digits, 10) : 0;
}

/** 4820000 -> "₦4,820,000". */
export function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString('en-NG')}`;
}
