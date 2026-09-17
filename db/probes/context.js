'use strict'

/**
 * Contesto di un'esecuzione delle prove: esiti, connessione amministratore, client dei ruoli di
 * prova (tutti chiusi a fine prova) e password dei ruoli, che restano solo in memoria.
 */
const dns = require('node:dns')
const pg = require('pg')

const DEFAULT_OPTIONS = {
  parallel: 5, // client contemporanei sul pooler in modalita' transazione, divisi tra i due ruoli
  rounds: 40, // transazioni esplicite per client, piu' altrettante istruzioni in autocommit
  sequential: 20, // connessioni aperte e chiuse una dopo l'altra
  sessionUserCalls: 100, // chiamate alla funzione SECURITY DEFINER sul pooler in modalita' transazione
  notifyHoldMs: 3000, // durata della transazione aperta dopo pg_notify, prima del commit
  waitMs: 10000, // attesa massima di un avviso
  idleSeconds: 420, // inattivita' degli ascoltatori in notify-idle
  minFreeConnections: 20 // margine minimo di connessioni libere per iniziare
}

/** Esiti `[OK]` / `[KO]` / `[INFO]`, stampati mentre arrivano e con il ref mascherato. */
class Report {
  constructor({ mask = String, write = (line) => console.log(line) } = {}) {
    this.mask = mask
    this.write = write
    this.results = []
  }

  add(level, id, text) {
    const entry = { level, id, text: this.mask(text) }
    this.results.push(entry)
    this.write(`[${level}] ${id} ${entry.text}`)
  }

  ok(id, text) {
    this.add('OK', id, text)
  }

  ko(id, text) {
    this.add('KO', id, text)
  }

  info(id, text) {
    this.add('INFO', id, text)
  }

  check(passed, id, text) {
    this.add(passed ? 'OK' : 'KO', id, text)
  }

  count(level) {
    return this.results.filter((result) => result.level === level).length
  }
}

/** Attesa locale di una condizione in memoria (nessuna interrogazione del database). */
function waitFor(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      if (predicate()) resolve(true)
      else if (Date.now() >= deadline) resolve(false)
      else setTimeout(tick, 25)
    }
    tick()
  })
}

/** Una query su una connessione forse morta non deve restare appesa ai tempi del TCP. */
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: nessuna risposta entro ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const errorText = (err) => `${err.code ? `${err.code} ` : ''}${err.message}`

function describeFamilies(addresses) {
  const count = (family) => addresses.filter((a) => a.family === family).length
  return `IPv4 x${count(4)}, IPv6 x${count(6)}`
}

function createContext({ endpoints, report, options = {} }) {
  const clients = new Set()
  const reachability = new Map()
  const defined = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined))

  const ctx = {
    endpoints,
    report,
    options: { ...DEFAULT_OPTIONS, ...defined },
    passwords: new Map(),
    admin: null,
    owner: null,

    async connectAdmin() {
      const admin = new pg.Client(endpoints.admin.config)
      // Un errore sulla connessione inattiva non deve diventare un'eccezione non gestita.
      admin.on('error', () => {})
      await admin.connect()
      ctx.admin = admin
      return admin
    },

    /** Client di un ruolo di prova su un endpoint; chiuso da `closeClients` se resta aperto. */
    async connect(endpoint, role, extra = {}) {
      const password = ctx.passwords.get(role)
      if (!password) throw new Error(`Password del ruolo ${role} non disponibile`)
      const client = new pg.Client(endpoint.configFor(role, password, extra))
      client.on('error', () => {})
      await client.connect()
      clients.add(client)
      client.once('end', () => clients.delete(client))
      return client
    },

    /** Risoluzione DNS e prova di collegamento, una volta per endpoint. */
    reachable(endpoint, role) {
      if (!reachability.has(endpoint.name)) {
        reachability.set(endpoint.name, (async () => {
          let addresses
          try {
            addresses = `DNS ${endpoint.host}: ${describeFamilies(await dns.promises.lookup(endpoint.host, { all: true }))}`
          } catch (err) {
            return { ok: false, reason: `DNS ${err.code || err.message}`, addresses: `DNS ${endpoint.host}: non risolto` }
          }
          try {
            const client = await ctx.connect(endpoint, role)
            await client.end()
            return { ok: true, addresses }
          } catch (err) {
            return { ok: false, reason: errorText(err), addresses }
          }
        })())
      }
      return reachability.get(endpoint.name)
    },

    async closeClients() {
      await Promise.all([...clients].map((client) => client.end().catch(() => {})))
      clients.clear()
    },

    async close() {
      await ctx.closeClients()
      if (ctx.admin) await ctx.admin.end().catch(() => {})
    }
  }
  return ctx
}

module.exports = { DEFAULT_OPTIONS, Report, createContext, errorText, waitFor, withTimeout }
