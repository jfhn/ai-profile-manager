/**
 * Child process environment for a bound profile.
 *
 * Cursor homes authenticate through auth.json. An inherited CURSOR_API_KEY
 * would switch the CLI to API-key mode and ignore that file, so it is
 * dropped whenever a Cursor profile env is applied. Setting the key to an
 * empty string is not enough.
 */
export function childProcessEnv(
  profileEnv: Record<string, string>,
  extra?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...profileEnv, ...extra };
  if (Object.hasOwn(profileEnv, 'CURSOR_CONFIG_DIR')) delete env.CURSOR_API_KEY;
  return env;
}
