/** A mask may remove native text and insert only the fixed redaction marker. */
export function applyRedactions(text, spans) {
  if (!Array.isArray(spans)) throw new Error('Invalid native reply redactions')
  let cursor = 0, result = ''
  for (const span of spans) {
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < cursor || span.end < span.start || span.end > text.length) throw new Error('Invalid native reply redaction span')
    result += text.slice(cursor, span.start) + '[REDACTED]'
    cursor = span.end
  }
  return result + text.slice(cursor)
}

export function redactionSpans(raw, clean) {
  if (raw === clean) return []
  const parts = clean.split('[REDACTED]')
  if (parts.length < 2 || !raw.startsWith(parts[0])) throw new Error('Reply redaction inserted non-native text')
  let cursor = parts[0].length
  const spans = []
  for (let index = 1; index < parts.length; index++) {
    const literal = parts[index]
    const end = index === parts.length - 1 ? raw.length - literal.length : raw.indexOf(literal, cursor)
    if (end < cursor || raw.slice(end, end + literal.length) !== literal) throw new Error('Reply redaction cannot be traced to native text')
    spans.push({ start: cursor, end })
    cursor = end + literal.length
  }
  if (applyRedactions(raw, spans) !== clean) throw new Error('Reply redaction does not match native text')
  return spans
}
