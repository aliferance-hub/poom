-- P2-H (H2/H19): row-level security baseline for the Supabase deployment.
--
-- WHY: every public table was created WITHOUT row-level security while the
-- database exposes the standard Supabase `anon`/`authenticated` roles (the
-- publishable anon key is public by design). With RLS disabled, those roles
-- had blanket grants inherited from the default privileges — a real exposure
-- even though POOM today never talks to Postgres with the anon key (all
-- access is server-side via Prisma with a privileged connection).
--
-- POLICY DELIBERATELY LEFT EMPTY: the application is the only sanctioned
-- data plane and connects with a superuser/privileged role that bypasses
-- RLS. Empty policies therefore mean: privileged app access is unaffected,
-- while every non-privileged PostgREST path (anon / authenticated) is denied
-- by default. If Supabase client-side access is ever introduced, explicit
-- policies MUST be authored for exactly the tables/columns that need it.
--
-- NOTES
--   * Idempotent: ENABLE ROW LEVEL SECURITY on an already-protected table is
--     a no-op, so re-running this file (psql -f) is safe.
--   * `_prisma_migrations` is intentionally excluded: it is Prisma-owned
--     bookkeeping, reachable only through the privileged migration
--     connection, and carries no customer data.
--   * Belt and suspenders: the blanket table grants Supabase gives to the
--     PostgREST API roles are revoked. Combined with empty policies this makes
--     the deny explicit (permission denied instead of empty result). The app
--     connects as the owner role and is unaffected.
--   * Supabase re-grants these to NEW tables via default privileges, so any
--     future table must be added to this baseline (the runbook covers it).
--   * No destructive statement: no data, column, constraint or owner changes.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
  END IF;
END $$;

ALTER TABLE "public"."Assembly" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Asset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."AssetVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Brand" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Cart" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."CartItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Category" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Engine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Fitment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."GarageVehicle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ImportBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ImportRow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."MeshMapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Offer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."OrderItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Part" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."PartIdentifier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."PartInquiry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."PaymentAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Refund" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."RelatedPart" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ReturnPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ReturnRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."SearchEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Seller" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."SellerEventLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."SellerOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Shipment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Transmission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Vehicle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."VehicleVariant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."VehicleZone" ENABLE ROW LEVEL SECURITY;
