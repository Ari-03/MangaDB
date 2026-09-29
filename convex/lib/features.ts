// Switches for public user-generated text. Reviews and Comments put readers'
// own words on public pages, which needs moderation in place first (a staffed
// queue, reports worked daily). Until then:
// - publicReviews: false keeps writing a Review possible but shows it to its
//   author only (reviews.list / hiddenList answer empty, profiles omit them);
// - comments: false refuses every Comment write and answers every read empty.
// The server enforces both; the client reads the same constants to hide the
// UI and skip the loaders' queries. Flip a flag here and deploy to turn it on.
export const FEATURES = {
  publicReviews: false,
  comments: false,
} as const;
