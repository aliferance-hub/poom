-- P2-G audit fix (M-1): a seller's own SKU identifies exactly one of their listings.
-- The CSV inventory import matches rows by seller_sku, so two listings sharing a
-- SKU made an import ambiguous (it silently updated whichever row the map kept).
-- Postgres treats NULLs as distinct in a unique index, so offers without a
-- seller_sku remain unlimited; non-null SKUs are unique per seller.
CREATE UNIQUE INDEX IF NOT EXISTS "Offer_sellerId_sellerSku_key"
  ON "Offer" ("sellerId", "sellerSku");
