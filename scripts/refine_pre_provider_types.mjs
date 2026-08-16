import fs from 'node:fs';

const path = 'src/types/index.ts';
let source = fs.readFileSync(path, 'utf8');

const failureAnchor = "  | 'upstream_failed'\n  | 'unknown';";
if (!source.includes(failureAnchor)) {
  throw new Error('FailureReason anchor not found.');
}
source = source.replace(
  failureAnchor,
  "  | 'upstream_failed'\n  | 'pre_provider_abandoned'\n  | 'pre_provider_authorization_failed'\n  | 'unknown';"
);

const auditAnchor = "export type AuditTaskStatus =\n  | 'validating'";
if (!source.includes(auditAnchor)) {
  throw new Error('AuditTaskStatus anchor not found.');
}
source = source.replace(
  auditAnchor,
  "export type AuditTaskStatus =\n  | 'validating'\n  | 'preparing'"
);

fs.writeFileSync(path, source);
console.log('Added first-class pre-provider failure and audit types.');
