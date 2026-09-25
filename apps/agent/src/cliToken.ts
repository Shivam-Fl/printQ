/**
 * The standalone CLI has no Windows credential-vault integration. Keep its
 * one-time setup token in process memory only; persistent setup belongs to
 * the signed desktop app, which uses the platform secure store.
 */
export async function loadEphemeralAgentToken(
  environmentToken: string | undefined,
  prompt: () => Promise<string>,
): Promise<string> {
  const fromEnvironment = environmentToken?.trim();
  if (fromEnvironment) return fromEnvironment;
  const entered = (await prompt()).trim();
  if (!entered) throw new Error('No agent token entered');
  return entered;
}
