/**
 * Non-secret process marker for an APM-launched remote T3 instance.
 *
 * The target-side `apm pair` command cross-checks this value against the
 * instance id in `--base-dir`. It is process attribution, not authentication:
 * provider credentials and pairing tokens never enter it.
 */
export const APM_MANAGED_T3_INSTANCE_ENV = 'APM_MANAGED_T3_INSTANCE_ID';
