# Security Policy

## Reporting

Report suspected vulnerabilities privately through GitHub Security Advisories for
this repository. If GHSA is unavailable to you, email security@openclaw.ai.

Do not open public issues for vulnerabilities or include secrets, private local
data, credentials, tokens, app data, or exploit details in public reports.

## Scope

In scope:

- Lobster bot package, runtime and package release surfaces
- config, credential, local filesystem, package, and workflow integrity surfaces
- command output, logs, artifacts, or generated data that could disclose private data
- dependency or runtime behavior that materially affects safe execution

Out of scope:

- upstream service outages, API changes, quotas, or account enforcement decisions
- compromise of a trusted local account, shell, filesystem, or maintainer device
- scanner-only findings without a reachable exploit path in supported usage

## Expectations

We prioritize reachable issues that affect credentials, private data, package
integrity, privileged automation, or safe execution. Include the affected commit,
platform, minimal reproduction steps, and sanitized impact details.
