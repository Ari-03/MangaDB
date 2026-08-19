// Display formatting shared by the catalog pages (Series from #22; Volume,
// Edition, and Bundle from #23).

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

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
