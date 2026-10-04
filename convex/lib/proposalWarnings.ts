// The warnings a Proposal can carry at submit (convex/proposals.ts computes
// them; the submitter acknowledges them), with the text the moderation pages
// show for each. Data only: the browser bundles this file, so it must not
// import server code (src/clientImports.test.ts checks).

export const PROPOSAL_WARNINGS = {
  newSeries: "Creates a brand-new Series",
  bulk: "Bulk change: more than 10 operations",
  partialCoverage: "Declares partial Volume Coverage",
} as const;

export type ProposalWarning = keyof typeof PROPOSAL_WARNINGS;
