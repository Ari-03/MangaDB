// Authors under a title: "Story by Gan Sunaaku · Art by Hikaru Suruga ·
// Original work by Hajime Isayama", each name linking to the author page.
// Shared by the Series, Volume, and Edition pages; credits come from ANN's
// staff rows (convex/people.ts), ordered makers first.

import { Link } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";

import { api } from "../../convex/_generated/api";
import { slugParams } from "~/lib/slug";

export type Credit = NonNullable<
  FunctionReturnType<typeof api.catalog.seriesPage>
>["credits"][number];
export type CreditRole = Credit["role"];

/** How a role reads before a name: "Story & Art by", "Original work by". */
export const ROLE_LABELS: Record<CreditRole, string> = {
  story_art: "Story & Art by",
  story: "Story by",
  art: "Art by",
  original: "Original work by",
};

/** Short role names, for chips on an author's shelf. */
export const ROLE_NAMES: Record<CreditRole, string> = {
  story_art: "Story & Art",
  story: "Story",
  art: "Art",
  original: "Original creator",
};

export function Byline({ credits }: { credits: ReadonlyArray<Credit> }) {
  if (credits.length === 0) return null;
  // One phrase per role, its names joined: "Story by A and B".
  const roles = [...new Set(credits.map((credit) => credit.role))];
  return (
    <p className="byline">
      {roles.map((role, i) => {
        const names = credits.filter((credit) => credit.role === role);
        return (
          <span key={role} className="byline-part">
            {i > 0 ? <span className="dot" aria-hidden="true" /> : null}
            <span className="byline-role">{ROLE_LABELS[role]}</span>{" "}
            {names.map((credit, j) => (
              <span key={credit.publicId}>
                {j > 0 ? (j === names.length - 1 ? " and " : ", ") : null}
                <Link
                  className="byline-name"
                  to="/author/$publicId/$slug"
                  params={slugParams(credit.publicId, credit.name)}
                >
                  {credit.name}
                </Link>
              </span>
            ))}
          </span>
        );
      })}
    </p>
  );
}
