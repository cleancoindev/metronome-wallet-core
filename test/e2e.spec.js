'use strict'

const { identity, once, toLower } = require('lodash')
const bip39 = require('bip39')
const BN = require('bn.js')
const chai = require('chai')
const createDebug = require('debug')
const util = require('util')

const chaiCrypro = require('./utils/chai-crypto')
const chaiNumericStrings = require('./utils/chai-numeric-strings')

chai
  .use(chaiCrypro)
  .use(chaiNumericStrings)
  .should()

require('dotenv').config()

createDebug.formatters.J = obj =>
  util.inspect(obj, { colors: true, depth: 4, sorted: true })
const debug = createDebug('metronome-wallet:core:test:e2e')

const createCore = require('..')

function addTests(fixtures) {
  const {
    address,
    blocksRange,
    config,
    receiptAddressFormatter,
    sendCoinDefaults,
    toAddress
  } = fixtures

  it('should initialize, emit rates and blocks', function(done) {
    this.timeout(240000)

    const core = createCore()
    const { api, emitter, events } = core.start(config)

    api.should.be.an('object')
    events.should.be.an('array')

    let blocksCount = 0
    let ratesCount = 0

    const end = once(function(err) {
      core.stop()
      done(err)
    })

    function checkEnd() {
      if (blocksCount >= 2 && ratesCount >= 2) {
        end()
      }
    }

    emitter.on('error', function(err) {
      end(err)
    })
    emitter.on('wallet-error', function(err) {
      end(new Error(err.message))
    })
    emitter.on('coin-block', function(blockHeader) {
      blockHeader.should.have.property('hash').that.is.an.eth.transactionHash
      blockHeader.should.have.property('number').that.is.a('number')
      blockHeader.should.have.property('timestamp').that.is.a('number')

      blocksCount += 1
      checkEnd()
    })
    emitter.on('coin-price-updated', function(data) {
      data.should.have.property('token', config.symbol)
      data.should.have.property('currency', 'USD')
      data.should.have.property('price').that.is.a('number')

      ratesCount += 1
      checkEnd()
    })
  })

  it('should emit wallet balance', function(done) {
    const core = createCore()
    const { emitter } = core.start(config)

    const walletId = 'walletId'

    const end = once(function(err) {
      core.stop()
      done(err)
    })

    emitter.on('error', function(err) {
      end(err)
    })
    emitter.on('wallet-error', function(err) {
      end(new Error(err.message))
    })
    emitter.on('wallet-state-changed', function(data) {
      try {
        data.should.have.nested
          .property(`${walletId}.addresses.${address}.balance`)
          .that.is.a('string')
          .that.represents.an('integer')
        end()
      } catch (err) {
        end(err)
      }
    })

    emitter.emit('open-wallets', { activeWallet: walletId, address })
  })

  it('should get past events', function(done) {
    const core = createCore()
    const { api, emitter } = core.start(config)

    const end = once(function(err) {
      core.stop()
      done(err)
    })

    emitter.on('error', function(err) {
      end(err)
    })
    emitter.on('wallet-error', function(err) {
      end(new Error(err.message))
    })

    const abi = api.erc20.abi
    api.metronome
      .getContractAddress('METToken')
      .then(contractAddress =>
        api.explorer
          .getPastEvents(abi, contractAddress, 'Transfer', {
            ...blocksRange,
            filter: { _from: address }
          })
          .then(function(events) {
            events.should.be.an('array').lengthOf(1)
            events[0].should.have.property(
              'transactionHash'
            ).that.is.an.eth.transactionHash
            events[0].should.have.nested.property('returnValues._from', address)
            end()
          })
      )
      .catch(end)
  })

  it('should emit past events', function(done) {
    this.timeout(60000)

    const core = createCore()
    const { api, emitter } = core.start(config)

    const walletId = 'walletId'

    const end = once(function(err) {
      core.stop()
      done(err)
    })

    let syncEnded = false
    let stateChanged = false

    function checkEnd() {
      if (syncEnded && stateChanged) {
        end()
      }
    }

    emitter.on('error', function(err) {
      end(err)
    })
    emitter.on('wallet-error', function(err) {
      end(new Error(err.message))
    })
    emitter.on('wallet-state-changed', function(data) {
      if (data[walletId].addresses[address].balance) {
        return
      }
      data[walletId].addresses[address].should.have.nested
        .property('transactions[0]')
        .that.include.all.keys('transaction', 'receipt', 'meta')
      // TODO check meta is parsed to native addresses
      stateChanged = true
      checkEnd()
    })
    emitter.on('coin-block', function() {
      const { fromBlock, toBlock } = blocksRange
      api.transactionsSyncer
        .getPastEvents(fromBlock, toBlock, address)
        .then(function() {
          syncEnded = true
          checkEnd()
        })
        .catch(end)
    })

    emitter.emit('open-wallets', {
      activeWallet: walletId,
      address
    })
  })

  it('should send coins and emit a wallet event', function(done) {
    this.timeout(0)

    const core = createCore()
    const { api, emitter } = core.start(config)

    const mnemonic = process.env.MNEMONIC
    const seed = bip39.mnemonicToSeedHex(mnemonic).toString('hex')
    const address0 = api.wallet.createAddress(seed)
    const privateKey = api.wallet.createPrivateKey(seed)
    const walletId = 'walletId'

    const to = toAddress
    const value = (Math.random() * 1000).toFixed()
    let events = 0

    const end = once(function(err) {
      core.stop()
      done(err)
    })

    emitter.on('error', function(err) {
      end(err)
    })
    emitter.on('wallet-error', function(err) {
      end(new Error(err.message))
    })
    emitter.on('wallet-state-changed', function(data) {
      try {
        const { transactions } = data[walletId].addresses[address0]
        if (!transactions) {
          return
        }
        debug('Transaction received %J', transactions)
        events += 1
        transactions.should.have.length(1)
        const { transaction, receipt, meta } = transactions[0]
        transaction.should.have.property('from', address0)
        transaction.should.have.property('hash').that.is.an.eth.transactionHash
        transaction.should.have.property('to', to)
        transaction.should.have.property('value', value)
        try {
          transaction.should.have.property('blockHash').that.is.an.eth.blockHash
          transaction.should.have.property('blockNumber').that.is.a('number')
          receipt.should.have.property('blockHash', transaction.blockHash)
          receipt.should.have.property('blockNumber', transaction.blockNumber)
          receipt.should.have.property(
            'from',
            receiptAddressFormatter(address0)
          )
          receipt.should.have.property('logs').that.is.an('array')
          receipt.should.have.property('status').that.is.true
          receipt.should.have.property('to', receiptAddressFormatter(to))
          receipt.should.have.property(
            'transactionHash'
          ).that.is.an.eth.transactionHash
          meta.should.deep.equal({ contractCallFailed: false })
          end()
        } catch (err) {
          if (events === 1) {
            debug('First event not complete: %s', err.message)
            return
          } else if (events === 2) {
            end(err)
          } else {
            end(new Error('Should have never receive a 3rd event'))
          }
        }
      } catch (err) {
        end(err)
      }
    })

    emitter.emit('open-wallets', {
      walletIds: [walletId],
      activeWallet: walletId,
      address: address0
    })

    const transactionObject = {
      ...sendCoinDefaults,
      from: address0,
      to,
      value
    }
    api.wallet.sendCoin(privateKey, transactionObject).catch(end)
  })

  it('should get status, buy MET and emit wallet events', function(done) {
    this.timeout(0)

    const self = this

    const core = createCore()
    const { api, emitter } = core.start(config)

    const mnemonic = process.env.MNEMONIC
    const seed = bip39.mnemonicToSeedHex(mnemonic).toString('hex')
    const address0 = api.wallet.createAddress(seed)
    const privateKey = api.wallet.createPrivateKey(seed)
    const walletId = 'walletId'

    const value = '1000000000000'
    let buyTxSent = false
    let events = 0

    const end = once(function(err) {
      core.stop()
      done(err)
    })

    emitter.on('error', function(err) {
      end(err)
    })
    emitter.on('wallet-error', function(err) {
      end(new Error(err.message))
    })
    emitter.on('auction-status-updated', function({ tokenRemaining }) {
      if (tokenRemaining === '0') {
        self.skip()
        return
      }
      if (buyTxSent) {
        return
      }
      buyTxSent = true
      Promise.all([
        api.metronome.getAuctionGasLimit({ from: address0, value }),
        api.explorer.getGasPrice()
      ])
        .then(([{ gasLimit }, { gasPrice }]) =>
          api.metronome.buyMetronome(privateKey, {
            from: address0,
            value,
            gas: gasLimit,
            gasPrice
          })
        )
        .catch(end)
    })
    emitter.on('wallet-state-changed', function(data) {
      try {
        const { transactions } = data[walletId].addresses[address0]
        if (!transactions) {
          return
        }
        debug('Transaction received %J', transactions)
        events += 1
        transactions.should.have.length(1)
        const { transaction, receipt, meta } = transactions[0]
        transaction.should.have.property('from', address0)
        transaction.should.have.property('hash').that.is.an.eth.transactionHash
        transaction.should.have.property('value', value)
        try {
          transaction.should.have.property('blockHash').that.is.an.eth.blockHash
          transaction.should.have.property('blockNumber').that.is.a('number')
          receipt.should.have.property('blockHash', transaction.blockHash)
          receipt.should.have.property('blockNumber', transaction.blockNumber)
          receipt.should.have.property(
            'from',
            receiptAddressFormatter(address0)
          )
          receipt.should.have.property('logs').that.is.an('array')
          receipt.logs
            .filter(log => log.topics[0].includes('a3d6792b')) // LogAuctionFundsIn
            .should.have.lengthOf(1)
          receipt.should.have.property('status').that.is.true
          receipt.should.have.property(
            'transactionHash'
          ).that.is.an.eth.transactionHash
          meta.should.deep.equal({ contractCallFailed: false })
          end()
        } catch (err) {
          if (events === 1) {
            debug('First event not complete: %s', err.message)
            return
          } else if (events === 2) {
            end(err)
          } else {
            end(new Error('Should have never receive a 3rd event'))
          }
        }
      } catch (err) {
        end(err)
      }
    })

    emitter.emit('open-wallets', {
      walletIds: [walletId],
      activeWallet: walletId,
      address: address0
    })
  })

  it('should send MET and emit wallet events', function(done) {
    this.timeout(0)

    const core = createCore()
    const { api, emitter } = core.start(config)

    const mnemonic = process.env.MNEMONIC
    const seed = bip39.mnemonicToSeedHex(mnemonic).toString('hex')
    const address0 = api.wallet.createAddress(seed)
    const privateKey = api.wallet.createPrivateKey(seed)
    const walletId = 'walletId'

    let events = 0
    let contractAddress
    let sent = false

    const end = once(function(err) {
      core.stop()
      done(err)
    })

    emitter.on('error', function(err) {
      end(err)
    })
    emitter.on('wallet-error', function(err) {
      end(new Error(err.message))
    })
    emitter.on('wallet-state-changed', function(data) {
      try {
        const { token, transactions } = data[walletId].addresses[address0]
        if (token && new BN(token[contractAddress].balance).ltn(10000000000)) {
          this.skip()
        } else if (token && !sent) {
          sent = true
          const transactionObject = {
            from: address0,
            to: address0,
            value: '10000000000'
          }
          api.metronome.sendMet(privateKey, transactionObject).catch(end)
        } else if (transactions) {
          debug('Transaction received %J', transactions)
          events += 1
          transactions.should.have.length(1)
          const { transaction, receipt, meta } = transactions[0]
          transaction.should.have.property('from', address0)
          transaction.should.have.property('hash').that.is.an.eth
            .transactionHash
          transaction.should.have.property('to', contractAddress)
          transaction.should.have.property('value', '0')
          try {
            transaction.should.have.property('blockHash').that.is.an.eth
              .blockHash
            transaction.should.have.property('blockNumber').that.is.a('number')
            receipt.should.have.property('blockHash', transaction.blockHash)
            receipt.should.have.property('blockNumber', transaction.blockNumber)
            receipt.should.have.property(
              'from',
              receiptAddressFormatter(address0)
            )
            receipt.should.have.property('logs').that.is.an('array')
            receipt.logs
              .filter(log => log.topics[0].includes('ddf252ad')) // Transfer
              .should.have.lengthOf(1)
            receipt.should.have.property('status').that.is.true
            receipt.should.have.property(
              'to',
              receiptAddressFormatter(contractAddress)
            )
            receipt.should.have.property('transactionHash').that.is.an.eth
              .transactionHash
            meta.should.deep.equal({ contractCallFailed: false })
            end()
          } catch (err) {
            if (events === 1) {
              debug('First event not complete: %s', err.message)
              return
            } else if (events === 2) {
              end(err)
            } else {
              end(new Error('Should have never receive a 3rd event'))
            }
          }
        }
      } catch (err) {
        end(err)
      }
    })

    api.metronome
      .getContractAddress('METToken')
      .then(function(_contracrAddress) {
        contractAddress = _contracrAddress
        emitter.emit('open-wallets', {
          activeWallet: walletId,
          address: address0
        })
      })
      .catch(end)
  })

  it('should estimate the conversion from coins to MET', function(done) {
    const core = createCore()
    const { api } = core.start(config)

    const end = once(function(err) {
      core.stop()
      done(err)
    })

    const value = '10000000000'
    api.metronome
      .getConvertCoinEstimate({ value })
      .then(function({ result }) {
        debug('Estimated MET %s', result)
        result.should.be.a('string').not.equal('0')
        end()
      })
      .catch(end)
  })

  it('should estimate the gas to convert coins to MET', function(done) {
    const core = createCore()
    const { api } = core.start(config)

    const end = once(function(err) {
      core.stop()
      done(err)
    })

    const from = address
    const value = '10000000000'
    api.metronome
      .getConvertCoinGasLimit({ from, value })
      .then(function({ gasLimit }) {
        debug('Estimated gas %s', gasLimit)
        gasLimit.should.be.a('number').not.equal('0')
        end()
      })
      .catch(end)
  })
}

describe('Core E2E', function() {
  before(function() {
    if (!process.env.E2E) {
      this.skip()
    }
  })

  describe('Core API', function() {
    it.skip('should expose the same API regardless the chain type', function() {
      // TODO check against the public/documented API
      const ethCore = createCore().start({
        chainId: 3,
        chainType: 'ethereum',
        indexerUrl: process.env.ROPSTEN_INDEXER,
        wsApiUrl: process.env.ROPSTEN_NODE,
        symbol: 'ETH'
      })
      const qtumCore = createCore().start({
        chainId: 'test',
        chainType: 'qtum',
        explorerApiUrl: process.env.QTUMTEST_EXPLORER,
        nodeUrl: process.env.QTUMTEST_NODE,
        symbol: 'QTUM'
      })
      qtumCore.api.should.have.all.keys(ethCore.api)
      qtumCore.events.should.have.members(ethCore.events)
    })
  })

  describe('Ethereum', function() {
    this.slow(40000) // 2 blocks
    const fixtures = {
      address: '0x079215597D4f6837e00e97099beE1F8974Bae61b',
      config: {
        indexerUrl: process.env.ROPSTEN_INDEXER,
        ratesUpdateMs: 5000,
        symbol: 'ETH',
        wsApiUrl: process.env.ROPSTEN_NODE
      },
      blocksRange: {
        fromBlock: 6802000,
        toBlock: 6802100
      },
      receiptAddressFormatter: toLower,
      sendCoinDefaults: {
        gas: 21000,
        gasPrice: '1000000000'
      },
      toAddress: process.env.TO_ETH_ADDRESS
    }
    addTests(fixtures)
  })

  describe('Qtum', function() {
    this.slow(256000) // 2 blocks
    const fixtures = {
      address: 'qTb9C5NeNTmKfNvvViTCUDsqBSDm9hrEe4',
      config: {
        chainId: 1364481358, // Fake EIP-155 testnet chain ID
        chainType: 'qtum',
        explorerApiUrl: process.env.QTUMTEST_EXPLORER,
        nodeUrl: process.env.QTUMTEST_NODE,
        ratesUpdateMs: 5000,
        symbol: 'QTUM'
      },
      blocksRange: {
        fromBlock: 485550,
        toBlock: 485600
      },
      receiptAddressFormatter: identity,
      sendCoinDefaults: {
        feeRate: 402
      },
      toAddress: process.env.TO_QTUM_ADDRESS
    }
    addTests(fixtures)
  })
})
