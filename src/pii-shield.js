const EMAIL_REGEX = /\b[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}\b/gi;

const PHONE_CANDIDATE_REGEX = /(?:(?:\+|00)\d{1,3}[\s.-]?(?:\(\d{1,4}\)|\d{1,4})[\s.-]?(?:\d{1,4}[\s.-]?){1,4}\d{1,9}|(?:\(\d{2,4}\)|\b\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}\b|\b\d{3}[-.\s]\d{4}\b|\b\d{10,12}\b)/g;

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
    emailsRedacted: 0,
    phonesRedacted: 0,
  };
}

export function redactPii(text, context = createPiiShieldContext()) {
  if (!text || typeof text !== 'string') {
    return {
      text: text || '',
      emailsRedacted: context.emailsRedacted,
      phonesRedacted: context.phonesRedacted,
      totalDirectIdentifiersRedacted: context.emailsRedacted + context.phonesRedacted,
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
    context,
  };
}
