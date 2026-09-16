'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readMigrations } = require('../db/runner/files')

function withDir(files, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'comfortplatform-files-'))
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content)
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('legge i file .sql ordinati per nome, con sha256 dei byte e contenuto', () => {
  withDir(
    {
      '0010_dopo.sql': 'select 10;\r\n',
      '0002_prima.sql': 'select 2;\n',
      'README.md': 'ignorato',
      '.gitkeep': ''
    },
    (dir) => {
      mkdirSync(path.join(dir, '0003_cartella.sql'))
      const migrations = readMigrations(dir)
      assert.deepEqual(
        migrations.map((m) => m.name),
        ['0002_prima.sql', '0010_dopo.sql']
      )
      // Nessuna normalizzazione: il CRLF entra nel checksum.
      assert.equal(migrations[1].checksum, createHash('sha256').update('select 10;\r\n').digest('hex'))
      assert.equal(migrations[0].sql, 'select 2;\n')
    }
  )
})

test('cartella vuota: nessuna migrazione', () => {
  withDir({}, (dir) => assert.deepEqual(readMigrations(dir), []))
})

test('rifiuta i nomi fuori formato, elencandoli tutti', () => {
  withDir(
    {
      '0001_ok.sql': '',
      '1_corto.sql': '',
      '0002-trattino.sql': '',
      '0003_Maiuscole.sql': '',
      '0004_estensione.SQL': '',
      '0005_.sql': ''
    },
    (dir) => {
      assert.throws(
        () => readMigrations(dir),
        (err) =>
          err.code === 'MIGRATION_FILES' &&
          ['1_corto.sql', '0002-trattino.sql', '0003_Maiuscole.sql', '0004_estensione.SQL', '0005_.sql'].every(
            (name) => err.message.includes(`${name}: il nome deve essere NNNN_nome.sql`)
          ) &&
          !err.message.includes('0001_ok.sql')
      )
    }
  )
})

test('rifiuta due file con lo stesso numero', () => {
  withDir({ '0002_alfa.sql': '', '0002_beta.sql': '' }, (dir) => {
    assert.throws(() => readMigrations(dir), {
      code: 'MIGRATION_FILES',
      message: /0002_beta\.sql: usa lo stesso numero di 0002_alfa\.sql/
    })
  })
})
