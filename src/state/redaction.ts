const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const AUTHORIZATION = /\b(authorization|proxy-authorization)\s*[:=]\s*(?:Bearer|Basic)\s+[^\s,;]+/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi;
const NAMED_SECRET = /\b([A-Z0-9_.-]*(?:API[_-]?KEY|ACCESS[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|AWS[_-]?SECRET[_-]?ACCESS[_-]?KEY|SECRET[_-]?ACCESS[_-]?KEY|CLIENT[_-]?SECRET|AUTHORIZATION|PASSWORD|PASSWD|SECRET|TOKEN))\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const COMMON_TOKEN = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

/** Redacts common credential formats before any free-form text reaches persistent state. */
export function redactSensitiveText(text: string): string {
  return text
    .replace(PRIVATE_KEY, "[REDACTED_PRIVATE_KEY]")
    .replace(AUTHORIZATION, "$1: [REDACTED]")
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(NAMED_SECRET, "$1=[REDACTED]")
    .replace(COMMON_TOKEN, "[REDACTED_CREDENTIAL]")
    .replace(JWT, "[REDACTED_CREDENTIAL]")
    .replace(URL_CREDENTIALS, "$1[REDACTED]@");
}

export function redactTextArray(values: string[]): string[] {
  return values.map(redactSensitiveText);
}
