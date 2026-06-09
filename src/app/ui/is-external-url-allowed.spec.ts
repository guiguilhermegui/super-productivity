import {
  ALLOWED_EXTERNAL_URL_SCHEMES,
  isExternalUrlSchemeAllowed,
} from '../../../electron/shared-with-frontend/is-external-url-allowed';

describe('isExternalUrlSchemeAllowed', () => {
  describe('allowed schemes', () => {
    const allowed = [
      'http://example.com',
      'https://example.com/path?q=1#frag',
      'HTTPS://EXAMPLE.COM', // scheme is case-insensitive
      'mailto:someone@example.com',
      'file:///home/user/notes.txt',
      '  https://example.com  ', // surrounding whitespace tolerated
    ];
    allowed.forEach((url) => {
      it(`allows "${url}"`, () => {
        expect(isExternalUrlSchemeAllowed(url)).toBe(true);
      });
    });

    it('keeps the allowlist in sync with expectations', () => {
      expect(ALLOWED_EXTERNAL_URL_SCHEMES).toEqual([
        'http:',
        'https:',
        'mailto:',
        'file:',
      ]);
    });
  });

  describe('blocked schemes (GHSA-hr87-735w-hfq3)', () => {
    const blocked = [
      'ms-calculator:',
      'ms-msdt:/id PCWDiagnostic', // Follina (CVE-2022-30190)
      'search-ms:query=foo',
      'ms-officecmd:{}',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'ftp://example.com',
      'ssh://example.com',
      'tel:+123456789',
      '\\\\192.168.1.100\\share', // UNC / SMB — NTLM hash capture
      '/\\192.168.1.100\\share',
    ];
    blocked.forEach((url) => {
      it(`blocks "${url}"`, () => {
        expect(isExternalUrlSchemeAllowed(url)).toBe(false);
      });
    });
  });

  describe('malformed / non-string input', () => {
    it('blocks empty and whitespace-only strings', () => {
      expect(isExternalUrlSchemeAllowed('')).toBe(false);
      expect(isExternalUrlSchemeAllowed('   ')).toBe(false);
    });

    it('blocks schemeless / relative input', () => {
      expect(isExternalUrlSchemeAllowed('example.com')).toBe(false);
      expect(isExternalUrlSchemeAllowed('//example.com')).toBe(false);
      expect(isExternalUrlSchemeAllowed('./relative/path')).toBe(false);
    });

    it('blocks non-string input', () => {
      expect(isExternalUrlSchemeAllowed(undefined)).toBe(false);
      expect(isExternalUrlSchemeAllowed(null)).toBe(false);
      expect(isExternalUrlSchemeAllowed(42)).toBe(false);
      expect(isExternalUrlSchemeAllowed({ href: 'https://example.com' })).toBe(false);
    });
  });
});
