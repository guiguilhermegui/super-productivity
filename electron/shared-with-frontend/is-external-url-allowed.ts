/**
 * URL schemes that are permitted to reach the OS handler via shell.openExternal.
 *
 * Task notes render Markdown links whose href would otherwise be passed verbatim
 * to the OS handler on click. Without this gate, anyone who can populate note
 * content (multi-device sync, shared/imported backups, issue-provider content)
 * could make a single click silently invoke any OS-registered protocol —
 * `ms-msdt:`, `search-ms:`, `\\host\share` (NTLM hash capture), etc.
 * See GHSA-hr87-735w-hfq3.
 *
 * Shared between the Angular renderer (link rendering) and the Electron main
 * process (shell.openExternal call sites) so both layers enforce one policy.
 */
/* eslint-disable @typescript-eslint/naming-convention */
export const ALLOWED_EXTERNAL_URL_SCHEMES = ['http:', 'https:', 'mailto:', 'file:'];
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Returns true only for URLs whose scheme is in ALLOWED_EXTERNAL_URL_SCHEMES.
 * Schemeless/relative input, Windows UNC/SMB paths (`\\host\share`), and any
 * string that fails URL parsing are rejected.
 */
export const isExternalUrlSchemeAllowed = (url: unknown): boolean => {
  if (typeof url !== 'string') {
    return false;
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return false;
  }
  // Reject Windows UNC / SMB paths up front: "\\host\share" has no URL scheme,
  // but the OS resolves it to a network path and leaks the user's NTLM hash.
  if (trimmed.startsWith('\\') || trimmed.startsWith('/\\')) {
    return false;
  }
  let protocol: string;
  try {
    protocol = new URL(trimmed).protocol;
  } catch {
    return false;
  }
  return ALLOWED_EXTERNAL_URL_SCHEMES.includes(protocol.toLowerCase());
};
