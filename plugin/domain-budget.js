// One budget definition for domain turn capture and Dreaming's proposed view.
export function validateDomainBudgets(documents, { memoryLines, memoryChars, soulChars, wikiLines }) {
  const lines = text => text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  const memory = documents.filter(document => document.kind === 'memory').map(document => document.text).join('\n\n')
  if ([...memory].length > memoryChars || lines(memory) > memoryLines) throw new Error('Domain knowledge exceeds its configured budget')
  for (const document of documents) {
    const count = lines(document.text), chars = [...document.text].length
    if (document.kind === 'memory' && (count > memoryLines || chars > memoryChars)
      || document.kind === 'soul' && chars > soulChars || document.kind === 'reference' && count > wikiLines) {
      throw new Error('Domain knowledge exceeds its configured budget')
    }
  }
}
