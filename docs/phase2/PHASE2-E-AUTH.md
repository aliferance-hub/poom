# P2-E — Authentication & Session Model

## Session store (DB-backed, hashed tokens)

`Session` model (migration `20260916_p2e_production_hardening`):

| field | notes |
|---|---|
| `id` | cuid |
| `userId` | FK → User (CASCADE) |
| `tokenHash` | **sha-256 of the cookie value** — the raw token never touches the DB |
| `createdAt` / `expiresAt` | explicit lifetime (30 days) |
| `revokedAt` | logout, admin suspension, session revocation |
| `lastSeenAt` | refreshed on resolve |

Uniqueness: `@@unique([tokenHash])` — one row per live token.

Cookie (`poom_uid_session`): `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `NODE_ENV=production`, `Max-Age = 30d`. The legacy `poom_uid` cookie remains only as a demo-mode fallback and is ignored whenever a valid Session row exists.

Resolution path (`src/lib/auth/session.ts`): read cookie → sha-256 → lookup by `tokenHash` → reject if `expiresAt < now` or `revokedAt != null` (and delete expired rows) → touch `lastSeenAt` → load `User` (role, status). **Role/status are always read from the DB row, never from any client value.**

## IdentityProvider abstraction (`src/lib/auth/identity.ts`)

```ts
interface IdentityProvider {
  authenticate(input: { phone: string }): Promise<AuthResult>;
  createSession(userId: string): Promise<{ token: string }>;
  destroySession(token: string): Promise<void>;
}
```

- `DemoIdentityProvider` — the only implementation shipped. It matches the phone against `SELLER_LOGIN` / `ADMIN_LOGIN` server-side env constants (never shipped to the browser) and creates/uses the matching User + Seller.
- Future `OtpIdentityProvider` / `PasswordIdentityProvider` plug into the same interface; the commerce/seller/admin layers never call the provider directly, only the guards.

## Role guards

- `requireCustomer()` — authenticated, `status = ACTIVE`, role CUSTOMER (admin/seller may also read, but customer-only mutations require a customer-owned session context).
- `getAuthenticatedSeller()` / `seller-auth-test.ts` — authenticated, `status = ACTIVE`, role SELLER, resolves the **server-side** Seller row, and requires `sellerStatus = ACTIVE` for mutations.
- `requireAdmin()` — authenticated, `status = ACTIVE`, role ADMIN. Used by every `/admin/*` page and server action.

Every guard re-verifies from the DB on each request. The browser is never authoritative for `userId`, `sellerId`, `role`, `verified`, or `sellerStatus` (§5, §15, §16).

## Demo-mode boundary (§13, §54)

- `DEMO_MODE=true` in `.env`/`.env.local`; demo login and the `/seller-demo` page are gated on it.
- Guard: `src/lib/auth/config.ts` throws at module load when `NODE_ENV=production && DEMO_MODE=true`, preventing the demo provider from silently running in production.

## Known limitations

- No OTP/password yet — phone-only demo authentication (provider interface is the seam for the real one).
- No session rotation on privilege change (only revoke-all on suspension/rejection).
