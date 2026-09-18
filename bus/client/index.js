'use strict'

/**
 * Libreria del bus di ComfortPlatform (ADR-0014 §14.7), importabile da CommonJS e da ESM:
 *
 *   const { publish, createConsumer } = require('comfort-platform')
 *   import { publish, createConsumer } from 'comfort-platform'
 *
 * Istruzioni in bus/client/README.md.
 */
const contract = require('../contract')
const { publish } = require('./publish')
const { createConsumer, BusListenError, LISTEN_APPLICATION_NAME } = require('./consumer')
const { knexClient } = require('./knex')

const { ContractError } = contract

module.exports = { publish, createConsumer, knexClient, contract, ContractError, BusListenError, LISTEN_APPLICATION_NAME }
