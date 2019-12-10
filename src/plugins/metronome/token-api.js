'use strict'

const { createMetronome, createProvider } = require('metronome-sdk')
const { toHex } = require('web3-utils')
const MetronomeContracts = require('metronome-contracts')

const { getExportMetFee } = require('./porter-api')

function estimateExportMetGas(coin) {
  const met = createMetronome(createProvider.fromLib(coin.lib))
  return function(params) {
    const {
      destinationChain,
      destinationMetAddress,
      extraData,
      fee,
      from,
      to,
      value
    } = params
    return met.estimateExportMetGas(
      {
        destChain: destinationChain,
        destMetronomeAddr: destinationMetAddress
      },
      to || from,
      value,
      fee,
      extraData,
      { from }
    )
  }
}

function estimateImportMetGas(web3, chain) {
  const { Auctions, METToken } = new MetronomeContracts(web3, chain)
  return function(params) {
    const {
      blockTimestamp,
      burnSequence,
      currentBurnHash,
      currentTick,
      dailyMintable,
      destinationChain,
      destinationMetAddress,
      extraData,
      fee,
      from,
      originChain,
      previousBurnHash,
      supply,
      root,
      value
    } = params
    return Promise.all([
      Auctions.methods.genesisTime().call(),
      Auctions.methods.dailyAuctionStartTime().call()
    ]).then(([genesisTime, dailyAuctionStartTime]) =>
      METToken.methods
        .importMET(
          toHex(originChain),
          toHex(destinationChain),
          [destinationMetAddress, from],
          extraData,
          [previousBurnHash, currentBurnHash],
          supply,
          [
            blockTimestamp,
            value,
            fee,
            currentTick,
            genesisTime,
            dailyMintable,
            burnSequence,
            dailyAuctionStartTime
          ],
          root
        )
        .estimateGas({ from })
    )
  }
}

function addAccount(web3, privateKey) {
  web3.eth.accounts.wallet
    .create(0)
    .add(web3.eth.accounts.privateKeyToAccount(privateKey))
}

const getNextNonce = (web3, from) =>
  web3.eth.getTransactionCount(from, 'pending')

function sendMet(getSigningLib, logTransaction, metaParsers) {
  return function(privateKey, { gasPrice, gas, from, to, value }) {
    const signingLib = getSigningLib(privateKey)
    const met = createMetronome(createProvider.fromLib(signingLib))
    return met.getContracts().then(({ METToken }) =>
      logTransaction(
        met.sendMet(to, value, { from, gasPrice, gas }),
        from,
        metaParsers.transfer({
          address: METToken.options.address,
          returnValues: { _from: from, _to: to, _value: value }
        })
      )
    )
  }
}

function exportMet(web3, chain, logTransaction, metaParsers) {
  const { METToken } = new MetronomeContracts(web3, chain)
  return function(privateKey, params) {
    const {
      destinationChain,
      destinationMetAddress,
      extraData,
      fee,
      from,
      gas,
      gasPrice,
      to,
      value
    } = params
    addAccount(web3, privateKey)
    return Promise.all([
      getNextNonce(web3, from),
      fee || getExportMetFee(web3, chain)({ value })
    ]).then(([nonce, actualFee]) =>
      logTransaction(
        METToken.methods
          .export(
            toHex(destinationChain),
            destinationMetAddress,
            to || from,
            value,
            actualFee,
            extraData
          )
          .send({ from, gasPrice, gas, nonce }),
        from,
        metaParsers.export({
          address: from,
          returnValues: {
            amountToBurn: value,
            destinationChain: toHex(destinationChain),
            destinationRecipientAddr: to || from,
            fee: actualFee
          }
        })
      )
    )
  }
}

function importMet(web3, chain, logTransaction, metaParsers) {
  const { Auctions, METToken } = new MetronomeContracts(web3, chain)
  return function(privateKey, params) {
    const {
      blockTimestamp,
      burnSequence,
      currentBurnHash,
      currentTick,
      dailyMintable,
      destinationChain,
      destinationMetAddress,
      extraData,
      fee,
      from,
      gas,
      gasPrice,
      originChain,
      previousBurnHash,
      supply,
      root,
      value
    } = params
    addAccount(web3, privateKey)

    return Promise.all([
      getNextNonce(web3, from),
      Auctions.methods.genesisTime().call(),
      Auctions.methods.dailyAuctionStartTime().call()
    ]).then(([nonce, genesisTime, dailyAuctionStartTime]) =>
      logTransaction(
        METToken.methods
          .importMET(
            toHex(originChain),
            toHex(destinationChain),
            [destinationMetAddress, from],
            extraData,
            [previousBurnHash, currentBurnHash],
            supply,
            [
              blockTimestamp,
              value,
              fee,
              currentTick,
              genesisTime,
              dailyMintable,
              burnSequence,
              dailyAuctionStartTime
            ],
            root
          )
          .send({ from, gasPrice, gas, nonce }),
        from,
        metaParsers.importRequest({
          returnValues: {
            amountToImport: value,
            currentBurnHash,
            fee,
            originChain: toHex(originChain),
            destinationRecipientAddr: from
          }
        })
      )
    )
  }
}

module.exports = {
  estimateExportMetGas,
  estimateImportMetGas,
  exportMet,
  importMet,
  sendMet
}
