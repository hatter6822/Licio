# Security Policy

## Reporting a Vulnerability

We take security vulnerabilities seriously, especially given that Licio handles
user-generated content and optional wallet connections.

### Private Disclosure

**Please do NOT open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities privately via:
- **Email**: security@licio.app
- **GitHub Security Advisories**: Use the "Report a vulnerability" button in the Security tab

### Response Commitment

- **Acknowledgment**: Within 48 hours of report
- **Initial assessment**: Within 5 business days
- **Fix timeline**: Critical vulnerabilities patched within 14 days; high within 30 days

### Scope

The following are in scope:
- XSS, CSRF, injection vulnerabilities in the web app or BFF
- Authentication and session management flaws
- CSP bypass or Trusted Types bypass
- Supply-chain vulnerabilities in direct dependencies
- Wallet/financial exploit vectors (when Knomosis is enabled)
- Privacy violations (attention signal leakage, tracking)
- **Invariant / ranking evasion** — a reproducible strategy that gains
  disproportionate reach while evading the open-source invariant ensemble
  (MERI/MFCI/SCOI/PHI/Tropical/Braid/…). The invariants are public by design
  (Kerckhoffs's principle); we actively invite evasion reports so weaknesses are
  found before they are weaponized. Please include the attack model and a
  scenario the ensemble adversarial suite
  (`apps/api/src/__tests__/invariants-ensemble-adversarial.test.ts`,
  `docs/invariants/ADVERSARIAL-THREATS.md`) does not already cover.

### Wallet/Financial Exploits

Vulnerabilities that could lead to unauthorized wallet transactions or fund drainage
follow an escalated incident-communications plan. These are treated as critical
regardless of CVSS score.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.8.x   | Yes       |

## Security Architecture

See `docs/SPEC.md` for the complete security architecture:
- **Section 25** — threat model and defense-in-depth strategy
- **Section 25.6** — incident response and vulnerability handling procedures
- **Section 6.12** — CI/CD security gates and supply-chain controls
