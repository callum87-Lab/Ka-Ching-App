# Security Policy

Ka-Ching! App is a personal, self-hosted-adjacent project maintained by one
person in their spare time. There's no dedicated security team, but reports
are taken seriously and looked at promptly.

## Reporting a vulnerability

Please use GitHub's [private vulnerability reporting](https://github.com/callum87-Lab/Ka-Ching-App/security/advisories/new)
for this repository rather than opening a public issue. This lets us discuss
and fix the problem before it's disclosed publicly.

You should expect an initial response within a few days. This is a hobby
project without paid support, so please be patient - there's no SLA, but
genuine reports won't be ignored.

## Supported versions

Only the latest release is supported. Older versions won't receive security
fixes - please update instead of reporting an issue against an old release.

## Scope

This app is local-first and doesn't run a public-facing server, so most
traditional web vulnerabilities don't apply. Relevant concerns include:
- Dependency vulnerabilities (tracked via Dependabot)
- Anything that could leak data from the local device or the optional
  sync connection to the web app
- Any unexpected outbound network activity
