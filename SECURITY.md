# Security Policy

## Supported versions

Licio is pre-1.0. Security fixes are accepted on the active `main` branch and on any explicitly supported release branch once releases begin.

## Reporting a vulnerability

Please report vulnerabilities privately to **security@licio.app**. Do not open a public issue for suspected vulnerabilities.

We aim to acknowledge reports within **2 business days**, provide an initial triage result within **5 business days**, and coordinate remediation and disclosure timelines with the reporter. Reports involving wallet interactions, session compromise, payment flows, private keys, seed phrases, or financial loss are treated as high-priority incidents and follow the incident-communications plan referenced by the security specification.

## Scope

In scope:

- Licio PWA client and service worker security.
- Licio API, session, CSRF, CORS, CSP, and Trusted Types controls.
- Dependency, build, SBOM, provenance, and lockfile-integrity concerns.
- Wallet-signature and payment/governance flows once implemented.

Out of scope:

- Social engineering against maintainers or users.
- Denial-of-service without a demonstrated security impact.
- Findings that require compromised maintainer machines or leaked secrets not caused by this repository.

## Safe harbor

Good-faith testing that avoids privacy violations, data destruction, persistence, and service disruption is welcome. We will not pursue legal action for research that follows this policy.
