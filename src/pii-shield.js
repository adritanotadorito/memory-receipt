const EMAIL_REGEX = /\b[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}\b/gi;

const PHONE_CANDIDATE_REGEX = /(?:(?:\+|00)\d{1,3}[\s.-]?(?:\(\d{1,4}\)|\d{1,4})[\s.-]?(?:\d{1,4}[\s.-]?){1,4}\d{1,9}|(?:\(\d{2,4}\)|\b\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}\b|\b\d{3}[-.\s]\d{4}\b|\b\d{10,12}\b)/g;

const CREDENTIAL_PAIR_REGEXES = [
  /(?:(?:user(?:name)?|login|account)\s*[:=]\s*[^\s,;]+[\s,;\r\n]+(?:pass(?:word|wd)?|pwd)\s*[:=]\s*[^\s,;]+)/gi,
  /(?:(?:pass(?:word|wd)?|pwd)\s*[:=]\s*[^\s,;]+[\s,;\r\n]+(?:user(?:name)?|login|account)\s*[:=]\s*[^\s,;]+)/gi,
  /(?:(?:user(?:name)?|login|account)\s+[^\s,;]+(?:\s+(?:and|with|\/)\s+|\s*,\s*)(?:pass(?:word|wd)?|pwd)\s+(?:is\s+|[:=]\s*)?[^\s,;]+)/gi,
  /(?:(?:pass(?:word|wd)?|pwd)\s+(?:is\s+|[:=]\s*)?[^\s,;]+(?:\s+(?:and|with|\/)\s+|\s*,\s*)(?:user(?:name)?|login|account)\s+[^\s,;]+)/gi,
];

const STANDALONE_CREDENTIAL_REGEXES = [
  /\b(?:password|passwd|pwd)\s*(?:[:=-]|\s+is\s+)\s*([^\s,;]+)/gi,
  /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|private[_-]?key)\s*(?:[:=-]|\s+is\s+)\s*([^\s,;]+)/gi,
  /\bBearer\s+([A-Za-z0-9_\-\.]{16,})\b/gi,
];

function isLikelyDate(str) {
  const s = str.trim();
  if (/^\d{4}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])$/.test(s)) return true;
  if (/^(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.](?:\d{4}|\d{2})$/.test(s)) return true;
  return false;
}

function isValidPhoneNumber(candidate) {
  const trimmed = candidate.trim();
  if (isLikelyDate(trimmed)) return false;

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return false;

  if (!trimmed.startsWith('+') && !trimmed.includes('(') && !trimmed.includes('-') && !trimmed.includes('.') && !trimmed.includes(' ')) {
    if (digits.length < 10) return false;
  }

  return true;
}

export function createPiiShieldContext() {
  return {
    emailMap: new Map(),
    phoneMap: new Map(),
    knownSecrets: new Set(),
    emailsRedacted: 0,
    phonesRedacted: 0,
    credentialsRedacted: 0,
  };
}

export function redactPii(text, context = createPiiShieldContext()) {
  if (!text || typeof text !== 'string') {
    return {
      text: text || '',
      emailsRedacted: context.emailsRedacted,
      phonesRedacted: context.phonesRedacted,
      totalDirectIdentifiersRedacted: context.emailsRedacted + context.phonesRedacted,
      credentialsRedacted: context.credentialsRedacted,
      context,
    };
  }

  let redacted = text.replace(EMAIL_REGEX, (match) => {
    const key = match.toLowerCase();
    if (!context.emailMap.has(key)) {
      const token = `[EMAIL_${context.emailMap.size + 1}]`;
      context.emailMap.set(key, token);
    }
    context.emailsRedacted++;
    return context.emailMap.get(key);
  });

  redacted = redacted.replace(PHONE_CANDIDATE_REGEX, (match) => {
    if (!isValidPhoneNumber(match)) {
      return match;
    }

    const trimmed = match.trim();
    const digits = trimmed.replace(/\D/g, '');
    const normKey = trimmed.startsWith('+') ? `+${digits}` : digits;

    if (!context.phoneMap.has(normKey)) {
      const token = `[PHONE_${context.phoneMap.size + 1}]`;
      context.phoneMap.set(normKey, token);
    }
    context.phonesRedacted++;

    const prefix = match.startsWith(' ') ? ' ' : '';
    const suffix = match.endsWith(' ') ? ' ' : '';
    return prefix + context.phoneMap.get(normKey) + suffix;
  });

  return {
    text: redacted,
    emailsRedacted: context.emailsRedacted,
    phonesRedacted: context.phonesRedacted,
    totalDirectIdentifiersRedacted: context.emailsRedacted + context.phonesRedacted,
    credentialsRedacted: context.credentialsRedacted,
    context,
  };
}

export function redactCredentials(text, context = createPiiShieldContext()) {
  if (!text || typeof text !== 'string') {
    return {
      text: text || '',
      credentialsRedacted: context.credentialsRedacted || 0,
      context,
    };
  }

  let redacted = text;

  for (const regex of CREDENTIAL_PAIR_REGEXES) {
    redacted = redacted.replace(regex, (match) => {
      const valMatch = match.match(/(?:pass(?:word|wd)?|pwd)\s*(?:[:=-]|\s+is\s+)?\s*([^\s,;]+)/i);
      if (valMatch && valMatch[1] && valMatch[1].length > 3) {
        context.knownSecrets.add(valMatch[1]);
      }
      context.credentialsRedacted++;
      return '[CREDENTIALS_REDACTED]';
    });
  }

  for (const regex of STANDALONE_CREDENTIAL_REGEXES) {
    redacted = redacted.replace(regex, (match, secretVal) => {
      if (secretVal && secretVal.length > 3) {
        context.knownSecrets.add(secretVal);
      }
      context.credentialsRedacted++;
      return '[CREDENTIAL_REDACTED]';
    });
  }

  if (context.knownSecrets && context.knownSecrets.size > 0) {
    for (const secret of context.knownSecrets) {
      if (secret && secret.length >= 4) {
        const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const secretRegex = new RegExp(`\\b${escaped}\\b`, 'g');
        if (secretRegex.test(redacted)) {
          redacted = redacted.replace(secretRegex, () => {
            context.credentialsRedacted++;
            return '[CREDENTIAL_REDACTED]';
          });
        }
      }
    }
  }

  return {
    text: redacted,
    credentialsRedacted: context.credentialsRedacted,
    context,
  };
}

export function redactPiiAndCredentials(text, context = createPiiShieldContext()) {
  const piiRes = redactPii(text, context);
  const credRes = redactCredentials(piiRes.text, context);
  return {
    text: credRes.text,
    emailsRedacted: context.emailsRedacted,
    phonesRedacted: context.phonesRedacted,
    totalDirectIdentifiersRedacted: context.emailsRedacted + context.phonesRedacted,
    credentialsRedacted: context.credentialsRedacted,
    context,
  };
}
