'use strict'

/**
 * Lettura della cartella delle migrazioni di piattaforma.
 *
 * Un file SQL con un nome fuori formato, o due file con lo stesso numero, fermano tutto:
 * ignorarli in silenzio vorrebbe dire applicare un insieme diverso da quello che si crede.
 */
const { createHash } = require('node:crypto')
const { readdirSync, readFileSync } = require('node:fs')
const path = require('node:path')

const NAME_RE = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/

/** sha256 esadecimale dei byte del file, senza normalizzazioni. */
function checksumOf(content) {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Restituisce le migrazioni ordinate per nome: `{ name, checksum, sql }`.
 * Considera i file con estensione .sql (senza distinguere maiuscole); ignora il resto.
 */
function readMigrations(dir) {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.sql$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort()

  const problems = []
  const byNumber = new Map()
  for (const name of names) {
    const match = NAME_RE.exec(name)
    if (!match) {
      problems.push(`${name}: il nome deve essere NNNN_nome.sql (minuscole, cifre e _)`)
      continue
    }
    const sameNumber = byNumber.get(match[1])
    if (sameNumber) problems.push(`${name}: usa lo stesso numero di ${sameNumber}`)
    else byNumber.set(match[1], name)
  }
  if (problems.length) {
    const error = new Error(
      `Cartella migrazioni non valida (${dir}):\n${problems.map((p) => `  - ${p}`).join('\n')}`
    )
    error.code = 'MIGRATION_FILES'
    throw error
  }

  return names.map((name) => {
    const content = readFileSync(path.join(dir, name))
    return { name, checksum: checksumOf(content), sql: content.toString('utf8') }
  })
}

module.exports = { NAME_RE, checksumOf, readMigrations }
