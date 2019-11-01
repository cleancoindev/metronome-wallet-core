'use strict'

const debug = require('debug')('metronome-wallet:core:qtum-wallet')

const wallet = require('./wallet')
const toPromiEvent = require('./to-promievent')

/**
 * Create the plugin.
 *
 * @returns {CorePlugin} The plugin.
 */
function createPlugin () {
  /**
   * Start the plugin.
   *
   * @param {CoreOptions} options The starting options.
   * @returns {CorePluginInterface} The plugin API.
   */
  function start ({ config, plugins }) {
    debug('Starting')

    const { chainId } = config

    const walletRPCProvider = wallet.forChain(chainId.toString())

    return {
      api: {
        createAddress: seed => walletRPCProvider.fromSeed(seed).wallet.address,
        createPrivateKey: wallet.getPrivateKey,
        // getAddressAndPrivateKey:
        // getGasLimit:
        // The min relay fee is set to 90400. For a 225 bytes tx, the fee rate
        // shall be >= 402 satoshis/byte.
        sendCoin (privateKey, { from, to, value, feeRate = 402 }) {
          debug('Sending Coin', to, value, feeRate)
          const sendPromise = walletRPCProvider
            .fromPrivateKey(privateKey)
            .wallet.send(to, Number.parseInt(value), { feeRate })
          const promiEvent = toPromiEvent(plugins.qtum.qtumRPC, sendPromise)
          return plugins.transactionsList.logTransaction(promiEvent, from)
        }
      },
      events: ['wallet-error', 'wallet-state-changed'],
      name: 'wallet'
    }
  }

  /**
   * Stop the plugin.
   */
  function stop () {}

  return {
    start,
    stop
  }
}

module.exports = createPlugin
