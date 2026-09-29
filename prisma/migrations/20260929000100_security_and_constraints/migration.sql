-- RePart: security hardening and invariants that Prisma cannot express (PLAN.md §2).
-- Safe to run on Supabase (roles anon/authenticated exist) and on the local test
-- Postgres (roles are created by docker/postgres-test/init.sql).

-- ─────────────────────────────────────────────────────────────
-- 1. Row Level Security on every table in public, with NO policies.
--    The app connects as the table owner (bypasses RLS); the Supabase
--    public API roles (anon, authenticated) can read/write nothing.
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 2. Partial unique indexes
-- ─────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "GarageVehicle_one_primary_per_user"
  ON "GarageVehicle" ("userId") WHERE "isPrimary" = true;

CREATE UNIQUE INDEX "SettingsVersion_one_active"
  ON "SettingsVersion" ("isActive") WHERE "isActive" = true;

CREATE UNIQUE INDEX "Order_one_open_order_per_listing"
  ON "Order" ("listingId")
  WHERE "state" NOT IN ('CANCELLED', 'COMPLETED', 'RESOLVED_REFUND', 'RESOLVED_RELEASE');

-- ─────────────────────────────────────────────────────────────
-- 3. CHECK constraints
-- ─────────────────────────────────────────────────────────────

-- Fitment links exactly one of a part number or a listing.
ALTER TABLE "Fitment" ADD CONSTRAINT "Fitment_exactly_one_subject"
  CHECK (num_nonnulls("partNumberId", "listingId") = 1);

-- Interchange: no self-links; FITS_WITH_MODIFICATION always carries notes.
ALTER TABLE "InterchangeLink" ADD CONSTRAINT "InterchangeLink_not_self"
  CHECK ("partNumberAId" <> "partNumberBId");
ALTER TABLE "InterchangeLink" ADD CONSTRAINT "InterchangeLink_modification_needs_notes"
  CHECK ("type" <> 'FITS_WITH_MODIFICATION' OR ("notes" IS NOT NULL AND length(btrim("notes")) > 0));

ALTER TABLE "Review" ADD CONSTRAINT "Review_rating_range" CHECK ("rating" BETWEEN 1 AND 5);

ALTER TABLE "Listing" ADD CONSTRAINT "Listing_wizard_step_range" CHECK ("wizardStep" BETWEEN 1 AND 7);
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_condition_score_range" CHECK ("conditionScore" IS NULL OR "conditionScore" BETWEEN 0 AND 100);
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_price_non_negative" CHECK ("pricePaise" IS NULL OR "pricePaise" >= 0);
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_pincode_format" CHECK ("pickupPincode" IS NULL OR "pickupPincode" ~ '^[1-9][0-9]{5}$');

ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_score_range" CHECK ("score" BETWEEN 0 AND 100);

ALTER TABLE "Address" ADD CONSTRAINT "Address_pincode_format" CHECK ("pincode" ~ '^[1-9][0-9]{5}$');
ALTER TABLE "PincodeGeo" ADD CONSTRAINT "PincodeGeo_pincode_format" CHECK ("pincode" ~ '^[1-9][0-9]{5}$');

ALTER TABLE "PartCategory" ADD CONSTRAINT "PartCategory_fees_non_negative"
  CHECK ("optionalCheckFee" >= 0 AND ("inspectionValueThreshold" IS NULL OR "inspectionValueThreshold" >= 0));
ALTER TABLE "MechanicPartner" ADD CONSTRAINT "MechanicPartner_fee_non_negative" CHECK ("feePerInspection" >= 0 AND "capacityPerDay" >= 0);
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_fee_non_negative" CHECK ("buyerFeePaise" >= 0);
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_values_non_negative"
  CHECK ("quotedFeePaise" >= 0 AND "weightGrams" > 0 AND "lengthCm" > 0 AND "widthCm" > 0 AND "heightCm" > 0);
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_refund_non_negative" CHECK ("refundAmountPaise" IS NULL OR "refundAmountPaise" >= 0);
ALTER TABLE "SellerRecovery" ADD CONSTRAINT "SellerRecovery_amount_positive" CHECK ("amountPaise" > 0);

-- Order money: ONE platform fee, Model S (PLAN §7.1, decision D-10).
--   total         = item + shipping + check          (fee is NOT added to the buyer total)
--   vendorShare   = item − platformFee               (seller payout)
--   merchantShare = shipping + check + platformFee
--   vendorShare + merchantShare = total
ALTER TABLE "Order" ADD CONSTRAINT "Order_money_non_negative"
  CHECK ("itemPricePaise" >= 0 AND "shippingFeePaise" >= 0 AND "checkFeePaise" >= 0
     AND "platformFeePaise" >= 0 AND "vendorSharePaise" >= 0 AND "merchantSharePaise" >= 0 AND "totalPaise" >= 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_fee_bps_range" CHECK ("platformFeeBps" BETWEEN 0 AND 10000);
ALTER TABLE "Order" ADD CONSTRAINT "Order_fee_within_item" CHECK ("platformFeePaise" <= "itemPricePaise");
ALTER TABLE "Order" ADD CONSTRAINT "Order_vendor_share" CHECK ("vendorSharePaise" = "itemPricePaise" - "platformFeePaise");
ALTER TABLE "Order" ADD CONSTRAINT "Order_merchant_share"
  CHECK ("merchantSharePaise" = "shippingFeePaise" + "checkFeePaise" + "platformFeePaise");
ALTER TABLE "Order" ADD CONSTRAINT "Order_total_is_sum_of_shares" CHECK ("vendorSharePaise" + "merchantSharePaise" = "totalPaise");

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_split_matches_amount"
  CHECK ("amountPaise" >= 0 AND "vendorSharePaise" >= 0 AND "merchantSharePaise" >= 0
     AND "vendorSharePaise" + "merchantSharePaise" = "amountPaise");

ALTER TABLE "Refund" ADD CONSTRAINT "Refund_portions_sum"
  CHECK ("vendorPortionPaise" >= 0 AND "merchantPortionPaise" >= 0 AND "amountPaise" > 0
     AND "amountPaise" = "vendorPortionPaise" + "merchantPortionPaise");

-- ─────────────────────────────────────────────────────────────
-- 4. Audit log is append-only.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.repart_audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only (% blocked)', TG_OP;
END;
$$;

CREATE TRIGGER "AuditLog_append_only"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION public.repart_audit_log_append_only();

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.repart_audit_log_append_only() FROM %I', r);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.repart_audit_log_append_only() FROM PUBLIC;
