-- Lets a single org be reached at its own fully-owned domain (e.g.
-- assets.360qm.co.th) instead of the shared "<subdomain>.<orgDomainSuffix>"
-- pattern every other org uses. Nullable and rare by design — most orgs
-- never set this and keep using the shared sslip.io-style subdomain.
ALTER TABLE organizations ADD COLUMN custom_domain TEXT;
CREATE UNIQUE INDEX organizations_custom_domain_key ON organizations (lower(custom_domain)) WHERE custom_domain IS NOT NULL;
