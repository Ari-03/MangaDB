// Display formatting shared across pages.

/** "1 book", "3 books": a count with its noun, plural unless the count is 1. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Partial-precision publication date (spec §8) at its known precision. */
export function formatPartialDate(
  date: { year: number; month?: number; day?: number } | null,
): string | null {
  if (!date) return null;
  const month = date.month ? MONTHS[date.month - 1] : undefined;
  if (month && date.day) return `${month} ${date.day}, ${date.year}`;
  if (month) return `${month} ${date.year}`;
  return String(date.year);
}

export function formatPrice(
  price: { amountCents: number; currency: string } | null,
): string | null {
  if (!price) return null;
  const amount = (price.amountCents / 100).toFixed(2);
  return price.currency === "USD" ? `$${amount}` : `${amount} ${price.currency}`;
}
