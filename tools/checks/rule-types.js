/**
 * The rule types a project may declare in `checks.json`.
 *
 * Its own module because two readers need it: `lib/checks.js` for help text and
 * errors, and `lib/rules.js` to validate that an `errors/` card points at a rule
 * that actually exists. Keeping it here avoids a cycle between those two.
 */
export const RULE_TYPES = [
  'doc-links',
  'contract-drift',
  'locale-parity',
  'import-boundary',
  'no-console',
  'session-message-identity',
  'undeclared-inject',
  'bare-name-dependency',
  'manifest-shape',
  'custom-session-event',
  'errors-card',
  'template-variants',
  'release-pipeline',
  'file-exists',
  'file-absent',
  'files-listed',
  'placeholder-free',
  'json-field',
  'frontmatter-name',
]