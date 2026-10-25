-- Original-quality development policy. Preserve custom account limits.
UPDATE quota_accounts SET limit_bytes=2147483648 WHERE limit_bytes=200000000;
