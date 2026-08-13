# MangaDB

A public database of manga volume releases, English-first: what volumes exist, when each edition comes out, and which ones you own or want.

## Language

**Series**:
A separately named manga work with its own Volume sequence, independent of language or publication packaging. A sequel or spinoff with its own numbering is another Series; a repackaging or renumbering of the same work is not.
_Avoid_: manga, title, work

**Series Family**:
A non-nestable umbrella for two or more related Series, such as "Tokyo Ghoul" and "Tokyo Ghoul:re." A Series belongs to at most one Series Family, while a lone Series does not have or display one.
_Avoid_: franchise, universe

**Series Relationship**:
A typed connection between Series in a Series Family, such as sequel, spinoff, or reboot.

**Volume**:
A stable collected-content unit within a Series, normally defined by the work's source publication and independent of later packaging. A separately identifiable published extra may be an unnumbered Volume; incidental bonus material is not a Volume.
_Avoid_: book, tankobon

**Volume Position**:
The stable ordinal placement of a Volume within its Series' single canonical reading sequence. It determines sequence independently of the Volume Label.

**Volume Label**:
The publisher-facing designation shown for a Volume, such as "7.5," "Side Story," or "Spring Log." It is not the Volume's identity or sort order.

**Release**:
A specific purchasable publication — one language, publisher, Format, Binding where applicable, optional Edition Line, content mapping, and optional ISBN-10 and ISBN-13 identifiers. An unchanged reprint or the same digital publication sold by another retailer retains its Release identity; a change to those publication characteristics creates another Release.
_Avoid_: edition, printing

**Release Variant**:
A visually distinct form of a Release, such as an alternate or box-set-exclusive cover, whose publication characteristics and content are otherwise unchanged. A user may identify the Release Variant they own without giving it a separate Release identity.

**Format**:
How a Release is published — physical or digital in v1.

**Binding**:
The physical construction of a Release, such as paperback or hardcover. Binding applies only to physical Releases.

**Edition Line**:
A publisher-named family of Releases, such as "Deluxe Edition" or "3-in-1," with consistent branding, content mapping, and numbering. An Edition Line may span physical and digital Formats; format alone does not define a different line, and ordinary Releases need not belong to any line.

**Edition Line Position**:
A Release's sequence label within its Edition Line, independent of the identities and numbers of the Volumes it covers.

**Volume Coverage**:
The ordered mapping from a Release to the Volumes whose content it contains, including whether each Volume is covered completely or partially. This lets split and omnibus Releases retain the identity of their source Volumes.

**Release Bundle**:
A purchasable, non-nestable package, such as a box set, containing multiple Releases. It has its own publication facts, while its member books retain their individual Release identities; the bundle may identify a particular Release Variant for a member.

**Series Reading Status**:
A user's explicitly chosen overall reading relationship with a Series: Plan to Read, Reading, Paused, Dropped, or Completed. It is not derived from progress through any particular Volume or Release.

**Release Progress**:
A user's active reading pass through a specific Release, optionally expressed as a user-estimated percentage from 0% to 100%. Reaching 100% suggests completion, but the pass is complete only after the user confirms it; confirmation increments the read count of every completely covered Volume and does not affect partially covered Volumes.

**Volume Progress**:
A user's edition-independent completed-reading history for a Volume, expressed as a completed read count. It may be updated directly or by confirmed completion of a Release that covers the Volume; another completed pass is a reread.
_Avoid_: Release Progress

**Collection Entry**:
A user's relationship to a specific Release or Release Bundle, in exactly one of three states: Wanted, Ordered, or Owned. A Release entry may optionally identify a Release Variant, and every Collection Entry is independent of Volume Progress.
_Avoid_: owned Volume, reading status

**Derived Ownership**:
Ownership of a Release inherited from an Owned Collection Entry for a Release Bundle containing it. Derived Ownership coexists with direct ownership and disappears with the bundle entry without erasing any direct entry.

**Series Follow**:
A user's explicit choice to track future Releases for a Series, independent of Collection Entries and Volume Progress. Recording another tracking fact may suggest a Series Follow but never creates one without confirmation.
_Avoid_: subscription

**Upcoming Release**:
A Canonical Release with a known future publication date. A hoped-for publication that no publisher has announced is not an Upcoming Release.

**My Upcoming Releases**:
A user's view of Upcoming Releases that either belong to a followed Series and match the user's Physical, Digital, or Both format preference, or have a Wanted or Ordered Collection Entry. Every item is a known Canonical Release; Wanted and Ordered entries appear regardless of the followed-Series format preference.

**Tracking Visibility**:
A user's private-by-default sharing policy for Ownership and Reading, with separate defaults for each and per-Series overrides. Visibility is not configured separately for individual Volumes or Releases.

**Publisher**:
The company issuing a Release (e.g. VIZ Media, Seven Seas).

**Source Observation**:
A fact reported by an external data source about a Series, Volume, or Release. Source Observations inform MangaDB's data but do not override an approved human decision.

**Canonical Record**:
MangaDB's currently approved representation of a Series, Volume, or Release. This is what the public site displays.

**Human Override**:
An approved field-level correction to a Canonical Record. Imports may report a conflicting Source Observation but cannot replace the corrected value until a Moderator explicitly clears the override.

**Revision**:
An immutable entry in a Canonical Record's public history describing an approved change, who or what made it, and why.

**Editor**:
A trusted contributor appointed by an Administrator or Moderator. Editors propose changes to Canonical Records; their proposals require Moderator approval.

**Moderator**:
A reviewer appointed by an Administrator. Moderators approve or reject proposed changes and may appoint Editors.

**Administrator**:
The role responsible for appointing Moderators and governing data-maintenance access.
