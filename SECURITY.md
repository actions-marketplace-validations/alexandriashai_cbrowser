# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 18.x    | :white_check_mark: |
| 17.x    | :x:                |
| < 17.0  | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in CBrowser, please report it responsibly:

1. **Do NOT open a public GitHub issue**
2. Email security concerns to: alexandria.shai.eden@gmail.com
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 1 week
- **Resolution**: Depends on severity (critical: 72 hours, high: 2 weeks)

## Security Architecture

CBrowser uses six layers of defense in depth. Full details in the [Security Whitepaper](https://cbrowser.ai/docs/security_whitepaper).

### Constitutional Safety (Built-in)

Every browser action is classified into one of four risk zones:

| Zone | Actions | Behavior |
|------|---------|----------|
| GREEN | Navigate, read, screenshot | Auto-execute |
| YELLOW | Click buttons, fill forms | Log and proceed |
| RED | Submit, delete, purchase | Requires verification |
| BLACK | Bypass auth, inject scripts | Never executes |

Classification is code-level and immutable. The AI cannot override it.

### Authentication

- **OAuth 2.1 PKCE** via login form (email + password)
- **API key auth** (`cbk_` keys with SHA-256 hashing)
- **Tier-based access** — tools gated by Free/Pro/Enterprise tier
- Keys never stored in plaintext; only hashes persisted

### Rate Limiting

- Per-account, tier-based rate limits
- Free: 100 req/hr, Pro: 1,000 req/hr, Enterprise: unlimited
- Burst allowance for initial requests

### Session Isolation

- Per-session browser instances with memory limits (800MB)
- Max 20 concurrent sessions
- Idle timeout (300s) with automatic cleanup
- Domain-scoped tool access — tools restricted to registered domains

### Credit System

- Per-tool credit costs (1-10 credits per call)
- Domain-scoped credit deduction
- Blocking denial when credits exhausted (no silent failures)

### Audit Trail

- Every tool call logged with account, domain, tool name, and timestamp
- Tool results auto-saved for analytics dashboard
- Score snapshots for historical tracking

## Discovery vs Action Surface

- `tools/list` and `initialize` are public (no auth required)
- `tools/call` requires authentication
- This follows the MCP convention: discovery is open, execution is gated

## Scope

This security policy covers:
- The CBrowser npm package
- The MCP server implementations (demo and enterprise)
- The cbrowser.ai website and CMS
- Official documentation

Third-party integrations and forks are not covered.

## Full Documentation

- [Security Whitepaper](https://cbrowser.ai/docs/security_whitepaper)
- [Constitutional Safety](https://cbrowser.ai/docs/constitutional-safety)
