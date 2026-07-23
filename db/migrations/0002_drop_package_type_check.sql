-- The old CHECK constraint pinned package_type to the four built-in keys, which
-- blocks user-defined custom types. Validation now happens in the API against
-- crm_package_types, so the constraint is no longer wanted.

ALTER TABLE crm_packages DROP CONSTRAINT IF EXISTS crm_packages_package_type_check;
