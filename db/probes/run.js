'use strict'

/**
 * Esecuzione di un comando delle prove: controllo preliminare, creazione degli oggetti di prova,
 * prove, pulizia e verifica dei residui. Pulizia e verifica girano sempre, anche se una prova
 * fallisce; un errore inatteso in una prova diventa un KO e non ferma le successive.
 */
const { createContext, errorText } = require('./context')
const { precheck, setup, cleanup, checkLeftovers } = require('./objects')
const { probeServer, checkHeadroom } = require('./server')
const { probeSearchPath } = require('./search-path')
const { probeSessionUser } = require('./session-user')
const { probeNotify, probeNotifyIdle } = require('./notify')

const PROBES = {
  'search-path': [['2', probeSearchPath]],
  'session-user': [['3', probeSessionUser]],
  notify: [['4', probeNotify]],
  'notify-idle': [['4.6', probeNotifyIdle]],
  all: [
    ['2', probeSearchPath],
    ['3', probeSessionUser],
    ['4', probeNotify]
  ]
}
const COMMANDS = ['server', ...Object.keys(PROBES), 'cleanup', 'leftovers']

async function runProbes(command, { endpoints, report, options }) {
  if (!COMMANDS.includes(command)) throw new Error(`Comando sconosciuto: ${command}. Comandi: ${COMMANDS.join(', ')}`)
  const ctx = createContext({ endpoints, report, options })
  await ctx.connectAdmin()
  try {
    if (command === 'leftovers') {
      await checkLeftovers(ctx)
      return
    }
    if (command === 'cleanup') {
      await cleanup(ctx)
      await checkLeftovers(ctx)
      return
    }
    if (command === 'server' || command === 'all') await probeServer(ctx)
    if (command === 'server') return

    await precheck(ctx)
    await checkHeadroom(ctx)
    try {
      await setup(ctx)
      for (const [id, probe] of PROBES[command]) {
        try {
          await probe(ctx)
        } catch (err) {
          report.ko(id, `prova interrotta da un errore inatteso: ${errorText(err)}`)
        }
      }
    } finally {
      try {
        await cleanup(ctx)
      } catch (err) {
        report.ko('C', `pulizia non completata: ${errorText(err)}. Rilanciare il comando cleanup`)
      }
      await checkLeftovers(ctx)
    }
  } finally {
    await ctx.close()
  }
}

module.exports = { COMMANDS, runProbes }
