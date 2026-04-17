# Chapter 3 — Multiplayer (auth + sharing)

**Commit:** [`bec92f0`](../../../../commit/bec92f0) · 2026-04-05 · 3,903 lines (+926) · Opus 4.6

## What I was solving

A shared Firestore doc with anonymous writes is fine for one trip with one friend. It's not fine once strangers can guess trip IDs, and it's useless the moment you want to invite someone by email or know who added what. Time to add Auth.

## What shipped

- **Firebase Auth with Google sign-in** (popup desktop, redirect mobile). Safari's ITP broke the default flow — fixed by proxying `/__/auth/*` through `vercel.json` to the Firebase auth domain so the cookie lands on the first-party origin.
- **Per-trip access control**: `access: { [uid]: 'owner'|'write' }` and `accessEmails: [lowercase-email]` for query indexing. `canEdit()` / `isOwner()` / `getTripRole()` gate every mutation.
- **Share modal**: owner invites by email. If the email already has a UID in `users/`, they're added directly. If not, a `pending_<email>` entry is stored and resolved on their next sign-in (`resolvePendingInvites()`).
- **Authorship**: every wishlist item and calendar event gets `addedBy`, `addedByPhoto`, `addedByUid`, `addedAt`. The avatar chip on a place card is the first visible proof that this is multiplayer.
- **Firestore security rules** (`firestore.rules`): owner-only create, shared users can write, public reads only allowed when `resource.data.public == true`.
- **Guest UX**: any signed-in viewer can see the trip read-only and request access.

## Working with Claude (Opus 4.6)

Security rules are a good AI collaboration case. The rule logic is declarative and easy to get subtly wrong — the email-in-dot-path bug (`pending_user@gmail.com` splitting into `{"pending_user@gmail":{"com":"write"}}`) only surfaces in production, with real data, when it's already too late. Claude wrote the rules; I wrote the test matrix. I described the access matrix (owner can X, writer can Y, public can Z, pending can auto-claim) and we iterated until the rules lined up with intent.

The ITP cookie proxy is the kind of fix you don't arrive at by reading one doc. Claude knew to look for it when I said "auth popup works on desktop, silent fail on iOS Safari."
