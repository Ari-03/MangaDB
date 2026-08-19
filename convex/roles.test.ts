// Role governance tests (ticket #31, spec §4/§5): the operator bootstrap of
// the initial Administrator, the appointment matrix, revocation and
// suspension, the permanent audit trail, and the promise that revocation
// never rewrites past attribution.

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import schema from "./schema";

const ADMIN = "user_admin";
const MOD = "user_mod";
const EDITOR = "user_editor";
const PLAIN = "user_plain";

async function withUsers(t: ReturnType<typeof convexTest>) {
  await t
    .withIdentity({ subject: ADMIN })
    .mutation(api.users.claimUsername, { username: "alice" });
  await t
    .withIdentity({ subject: MOD })
    .mutation(api.users.claimUsername, { username: "bob" });
  await t
    .withIdentity({ subject: EDITOR })
    .mutation(api.users.claimUsername, { username: "carol" });
  await t
    .withIdentity({ subject: PLAIN })
    .mutation(api.users.claimUsername, { username: "dave" });
}

async function bootstrapAdmin(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.roles.bootstrapAdministrator, {
    username: "alice",
  });
}

describe("roles.bootstrapAdministrator", () => {
  it("appoints the initial Administrator with a system-actor audit row", async () => {
    const t = convexTest(schema);
    await withUsers(t);
    const result = await t.mutation(internal.roles.bootstrapAdministrator, {
      username: "alice",
    });
    expect(result).toEqual({ username: "alice", role: "administrator" });

    const audit = await t.run((ctx) => ctx.db.query("roleAudit").collect());
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "appointed",
      role: "administrator",
      actor: { kind: "system" },
    });
  });

  it("refuses once any Administrator exists", async () => {
    const t = convexTest(schema);
    await withUsers(t);
    await bootstrapAdmin(t);
    await expect(
      t.mutation(internal.roles.bootstrapAdministrator, { username: "bob" }),
    ).rejects.toMatchObject({ data: { code: "alreadyBootstrapped" } });
  });
});

describe("roles.appoint", () => {
  it("lets an Administrator appoint a Moderator, audited", async () => {
    const t = convexTest(schema);
    await withUsers(t);
    await bootstrapAdmin(t);
    await t
      .withIdentity({ subject: ADMIN })
      .mutation(api.roles.appoint, { username: "bob", role: "moderator" });

    const mod = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("usernameNormalized", "bob"))
        .unique(),
    );
    expect(mod?.role).toBe("moderator");

    const audit = await t.run((ctx) => ctx.db.query("roleAudit").collect());
    const appointment = audit.find((row) => row.role === "moderator");
    expect(appointment).toMatchObject({ action: "appointed" });
    expect(appointment?.actor.kind).toBe("user");
  });

  it("lets a Moderator appoint an Editor but not another Moderator", async () => {
    const t = convexTest(schema);
    await withUsers(t);
    await bootstrapAdmin(t);
    await t
      .withIdentity({ subject: ADMIN })
      .mutation(api.roles.appoint, { username: "bob", role: "moderator" });

    const asMod = t.withIdentity({ subject: MOD });
    await asMod.mutation(api.roles.appoint, {
      username: "carol",
      role: "editor",
    });
    await expect(
      asMod.mutation(api.roles.appoint, { username: "dave", role: "moderator" }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  it("rejects appointments from Editors and plain users", async () => {
    const t = convexTest(schema);
    await withUsers(t);
    await bootstrapAdmin(t);
    await t
      .withIdentity({ subject: ADMIN })
      .mutation(api.roles.appoint, { username: "carol", role: "editor" });

    for (const subject of [EDITOR, PLAIN]) {
      await expect(
        t
          .withIdentity({ subject })
          .mutation(api.roles.appoint, { username: "dave", role: "editor" }),
      ).rejects.toThrow(ConvexError);
    }
  });

  it("audits a role change as revocation + appointment", async () => {
    const t = convexTest(schema);
    await withUsers(t);
    await bootstrapAdmin(t);
    const asAdmin = t.withIdentity({ subject: ADMIN });
    await asAdmin.mutation(api.roles.appoint, { username: "bob", role: "editor" });
    await asAdmin.mutation(api.roles.appoint, {
      username: "bob",
      role: "moderator",
    });

    const audit = await t.run((ctx) => ctx.db.query("roleAudit").collect());
    const actions = audit.map((row) => `${row.action}:${row.role}`);
    expect(actions).toContain("appointed:editor");
    expect(actions).toContain("revoked:editor");
    expect(actions).toContain("appointed:moderator");
  });
});

describe("roles.revoke", () => {
  it("removes the role and audits, leaving prior audit rows intact", async () => {
    const t = convexTest(schema);
    await withUsers(t);
    await bootstrapAdmin(t);
    const asAdmin = t.withIdentity({ subject: ADMIN });
    await asAdmin.mutation(api.roles.appoint, {
      username: "carol",
      role: "editor",
    });
    await asAdmin.mutation(api.roles.revoke, {
      username: "carol",
      reason: "stepping down",
    });

    const editor = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("usernameNormalized", "carol"))
        .unique(),
    );
    expect(editor?.role).toBeUndefined();

    const audit = await t.run((ctx) => ctx.db.query("roleAudit").collect());
    expect(audit.filter((row) => row.action === "appointed")).toHaveLength(2);
    expect(audit.filter((row) => row.action === "revoked")).toHaveLength(1);
  });

  it("never removes the last active Administrator", async () => {
    const t = convexTest(schema);
    await withUsers(t);
    await bootstrapAdmin(t);
    await expect(
      t
        .withIdentity({ subject: ADMIN })
        .mutation(api.roles.revoke, { username: "alice" }),
    ).rejects.toMatchObject({ data: { code: "lastAdministrator" } });
  });

  it("keeps past attribution: revisions retain the role at authorship", async () => {
    const t = convexTest(schema);
    await withUsers(t);
    await bootstrapAdmin(t);
    const asAdmin = t.withIdentity({ subject: ADMIN });
    await asAdmin.mutation(api.roles.appoint, {
      username: "bob",
      role: "moderator",
    });

    const seriesId = await t.run((ctx) =>
      ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "Alpha",
        altTitles: [],
        searchText: "Alpha",
      }),
    );
    await t.withIdentity({ subject: MOD }).mutation(
      api.moderation.submitDirectEdit,
      {
        ref: { type: "series", id: seriesId },
        changes: [{ field: "title", value: "Beta" }],
        comment: "Official romanization.",
      },
    );

    await asAdmin.mutation(api.roles.revoke, { username: "bob" });

    const revisions = await t.run((ctx) => ctx.db.query("revisions").collect());
    expect(revisions).toHaveLength(1);
    expect(revisions[0].author).toMatchObject({
      kind: "user",
      roleAtAuthorship: "moderator",
    });
  });
});

describe("roles.suspend / reinstate", () => {
  it("suspension removes privileges immediately; reinstatement restores them", async () => {
    const t = convexTest(schema);
    await withUsers(t);
    await bootstrapAdmin(t);
    const asAdmin = t.withIdentity({ subject: ADMIN });
    await asAdmin.mutation(api.roles.appoint, {
      username: "bob",
      role: "moderator",
    });
    const seriesId = await t.run((ctx) =>
      ctx.db.insert("series", {
        status: "active",
        publicId: 1,
        title: "Alpha",
        altTitles: [],
        searchText: "Alpha",
      }),
    );

    await asAdmin.mutation(api.roles.suspend, {
      username: "bob",
      reason: "under review",
    });
    await expect(
      t.withIdentity({ subject: MOD }).mutation(api.moderation.submitDirectEdit, {
        ref: { type: "series", id: seriesId },
        changes: [{ field: "title", value: "Beta" }],
        comment: "Trying anyway.",
      }),
    ).rejects.toMatchObject({ data: { code: "suspended" } });

    await asAdmin.mutation(api.roles.reinstate, { username: "bob" });
    await t.withIdentity({ subject: MOD }).mutation(
      api.moderation.submitDirectEdit,
      {
        ref: { type: "series", id: seriesId },
        changes: [{ field: "title", value: "Beta" }],
        comment: "Official romanization.",
      },
    );

    const audit = await t.run((ctx) => ctx.db.query("roleAudit").collect());
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining(["suspended", "reinstated"]),
    );
  });

  it("refuses self-suspension and suspending the last Administrator", async () => {
    const t = convexTest(schema);
    await withUsers(t);
    await bootstrapAdmin(t);
    const asAdmin = t.withIdentity({ subject: ADMIN });
    await expect(
      asAdmin.mutation(api.roles.suspend, { username: "alice", reason: "no" }),
    ).rejects.toThrow(ConvexError);
  });
});

describe("roles.roster & auditLog", () => {
  it("are data-team only and reflect the current holders", async () => {
    const t = convexTest(schema);
    await withUsers(t);
    await bootstrapAdmin(t);
    await t
      .withIdentity({ subject: ADMIN })
      .mutation(api.roles.appoint, { username: "bob", role: "moderator" });

    await expect(
      t.withIdentity({ subject: PLAIN }).query(api.roles.roster, {}),
    ).rejects.toThrow(ConvexError);

    const roster = await t
      .withIdentity({ subject: ADMIN })
      .query(api.roles.roster, {});
    expect(roster).toEqual([
      { username: "alice", role: "administrator", suspended: false },
      { username: "bob", role: "moderator", suspended: false },
    ]);

    const log = await t
      .withIdentity({ subject: MOD })
      .query(api.roles.auditLog, {});
    expect(log[0]).toMatchObject({
      action: "appointed",
      role: "moderator",
      username: "bob",
      actor: { kind: "user", username: "alice" },
    });
    expect(log[log.length - 1]).toMatchObject({
      action: "appointed",
      role: "administrator",
      actor: { kind: "system" },
    });
  });
});
