import { performance } from 'perf_hooks';
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { Umbra } from '../src/classes/Umbra';
import { KeyPair } from '../src/classes/KeyPair';
import { RandomNumber } from '../src/classes/RandomNumber';
import hardhatConfig from '../hardhat.config';
import {
  Umbra as UmbraContract,
  Umbra__factory,
} from '../src/typechain';
import {
  BigNumber, StaticJsonRpcProvider, Wallet, BigNumberish, getAddress
} from '../src/ethers';
import { HardhatNetworkHDAccountsUserConfig } from 'hardhat/src/types/config';
import {
  lookupRecipient, assertSupportedAddress
} from '../src/utils/utils';
import type { Announcement, ChainConfig, EthersProvider, ScanOverrides, SendOverrides, SubgraphAnnouncement, UserAnnouncement, AnnouncementDetail, SendBatch, SendData } from '../src/types'; // prettier-ignore
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { UMBRA_BATCH_SEND_ABI } from '../src/utils/constants';

const ethersProvider = ethers.provider;
// We don't use the 0 or 1 index just to reduce the chance of conflicting with a signer for another use case
const senderIndex = 2;
const receiverIndex = 3;
const { parseEther } = ethers.utils;
const ETH_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const quantity = parseEther('500');
const overrides = { supportPubKey: true }; // we directly enter a pubkey in these tests for convenience

// Helper function to compute the average after removing the fastest and slowest measurement.
function computeAverageWithoutMinMax(arr: number[]): number {
  if (arr.length <= 2) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const trimmed = sorted.slice(1, sorted.length - 1);
  const sum = trimmed.reduce((acc, val) => acc + val, 0);
  return sum / trimmed.length;
}

async function benchmarkPrepareSend(umbra: Umbra, recipientPublicKey: string, lookupOverrides: SendOverrides = {}) {
  await assertSupportedAddress(recipientPublicKey);

  const totalStart = performance.now();

  // Skipping lookup step: use the provided recipientPublicKey for both spending and viewing keys
  const spendingPublicKey = recipientPublicKey;
  const viewingPublicKey = recipientPublicKey;

  // Step 2: Create KeyPair instances
  const keyPairStart = performance.now();
  const spendingKeyPair = new KeyPair(spendingPublicKey);
  const viewingKeyPair = new KeyPair(viewingPublicKey);
  const keyPairDuration = performance.now() - keyPairStart;
  // console.log(`KeyPair creation took: ${keyPairDuration.toFixed(4)} ms`);

  // Step 3: Generate a random number
  const randomStart = performance.now();
  const randomNumber = new RandomNumber();
  const randomDuration = performance.now() - randomStart;
  // console.log(`Random number generation took: ${randomDuration.toFixed(4)} ms`);

  // Step 4: Encrypt the random number using the recipient's viewing key
  const encryptionStart = performance.now();
  const encrypted = viewingKeyPair.encrypt(randomNumber);
  const encryptionDuration = performance.now() - encryptionStart;
  // console.log(`Encryption took: ${encryptionDuration.toFixed(4)} ms`);

  // Step 5: Compress the ephemeral public key (extract the x-coordinate)
  const compressStart = performance.now();
  const { pubKeyXCoordinate } = KeyPair.compressPublicKey(encrypted.ephemeralPublicKey);
  const compressDuration = performance.now() - compressStart;
  // console.log(`Public key compression took: ${compressDuration.toFixed(4)} ms`);

  // Step 6: Compute the stealth address using the random number and spending key
  const stealthStart = performance.now();
  const stealthKeyPair = spendingKeyPair.mulPublicKey(randomNumber);
  const stealthDuration = performance.now() - stealthStart;
  // console.log(`Stealth address computation took: ${stealthDuration.toFixed(4)} ms`);

  const totalDuration = performance.now() - totalStart;
  // console.log(`Total prepareSend execution time: ${totalDuration.toFixed(4)} ms`);

  return {
    stealthKeyPair,
    pubKeyXCoordinate,
    encrypted,
    durations: {
      keyPairDuration,
      randomDuration,
      encryptionDuration,
      compressDuration,
      stealthDuration,
      totalDuration
    }
  };
}

async function benchmarkScan(
  umbra: Umbra,
  spendingPublicKey: string,
  viewingPrivateKey: string,
  maxBatches: number = 3,
  overrides: ScanOverrides = {}
) {
  const totalStart = performance.now();
  const batchRetrievalDurations: number[] = [];
  // const announcementProcessingDurations: number[] = [];
  const isAnnouncementStep1Durations: number[] = [];
  const isAnnouncementStep2Durations: number[] = [];
  const isAnnouncementStep3Durations: number[] = [];
  const isAnnouncementStep4Durations: number[] = [];
  const isAnnouncementTotalDurations: number[] = [];
  const userAnnouncements: UserAnnouncement[] = [];
  let totalAnnouncementsCount = 0;
  let processedBatches = 0;

  // Create an iterator for fetchAllAnnouncements to measure retrieval time per batch
  const announcementsIterator = umbra.fetchAllAnnouncements(overrides);
  while (true) {
    const batchStart = performance.now();
    const { value: announcementsBatch, done } = await announcementsIterator.next();
    const batchEnd = performance.now();
    if (done) break;
    const batchRetrievalTime = batchEnd - batchStart;
    batchRetrievalDurations.push(batchRetrievalTime);

    // Process each announcement in the batch using the benchmarkIsAnnouncementForUser function
    for (const announcement of announcementsBatch) {
      const result = benchmarkIsAnnouncementForUser(umbra, spendingPublicKey, viewingPrivateKey, announcement);
      isAnnouncementStep1Durations.push(result.durations.step1Duration);
      isAnnouncementStep2Durations.push(result.durations.step2Duration);
      isAnnouncementStep3Durations.push(result.durations.step3Duration);
      isAnnouncementStep4Durations.push(result.durations.step4Duration);
      const totalOperationTime = result.durations.step1Duration + result.durations.step2Duration + result.durations.step3Duration + result.durations.step4Duration;
      isAnnouncementTotalDurations.push(totalOperationTime);
      totalAnnouncementsCount++;

      if (result.isForUser) {
        const token = getAddress(announcement.token);
        const isWithdrawn = false;
        userAnnouncements.push({
          randomNumber: result.randomNumber,
          receiver: announcement.receiver,
          amount: announcement.amount,
          token,
          from: announcement.from,
          txHash: announcement.txHash,
          timestamp: announcement.timestamp,
          isWithdrawn
        });
      }
    }
    processedBatches++;
    if (processedBatches >= maxBatches) break;
  }

  const totalScanTime = performance.now() - totalStart;
  const averageBatchRetrievalTime =
    batchRetrievalDurations.length > 0
      ? batchRetrievalDurations.reduce((a, b) => a + b, 0) / batchRetrievalDurations.length
      : 0;

  return {
    userAnnouncements,
    durations: {
      totalScanTime,
      averageBatchRetrievalTime,
      batchRetrievalDurations,
      isAnnouncementStep1Durations,
      isAnnouncementStep2Durations,
      isAnnouncementStep3Durations,
      isAnnouncementStep4Durations,
      averageIsAnnouncementStep1: isAnnouncementStep1Durations.length
        ? isAnnouncementStep1Durations.reduce((a, b) => a + b, 0) / isAnnouncementStep1Durations.length
        : 0,
      averageIsAnnouncementStep2: isAnnouncementStep2Durations.length
        ? isAnnouncementStep2Durations.reduce((a, b) => a + b, 0) / isAnnouncementStep2Durations.length
        : 0,
      averageIsAnnouncementStep3: isAnnouncementStep3Durations.length
        ? isAnnouncementStep3Durations.reduce((a, b) => a + b, 0) / isAnnouncementStep3Durations.length
        : 0,
      averageIsAnnouncementStep4: isAnnouncementStep4Durations.length
        ? isAnnouncementStep4Durations.reduce((a, b) => a + b, 0) / isAnnouncementStep4Durations.length
        : 0,
      isAnnouncementTotalDurations,
      averageIsAnnouncementTotal: isAnnouncementTotalDurations.length
        ? isAnnouncementTotalDurations.reduce((a, b) => a + b, 0) / isAnnouncementTotalDurations.length
        : 0,
    }
  };
}

function benchmarkIsAnnouncementForUser(umbra: Umbra, spendingPublicKey: string, viewingPrivateKey: string, announcement: Announcement) {
  let step1Duration = 0;
  let step2Duration = 0;
  let step3Duration = 0;
  let step4Duration = 0;
  try {
    const { receiver, pkx, ciphertext } = announcement;

    // Step 1: Get uncompressed public key from pkx
    const step1Start = performance.now();
    const uncompressedPubKey = KeyPair.getUncompressedFromX(pkx);
    const step1End = performance.now();
    step1Duration = step1End - step1Start;

    // Step 2: Decrypt payload to get random number
    const step2Start = performance.now();
    const payload = { ephemeralPublicKey: uncompressedPubKey, ciphertext };
    const viewingKeyPair = new KeyPair(viewingPrivateKey);
    const randomNumber = viewingKeyPair.decrypt(payload);
    const step2End = performance.now();
    step2Duration = step2End - step2Start;

    // Step 3: Compute the receiving address
    const step3Start = performance.now();
    const spendingKeyPair = new KeyPair(spendingPublicKey);
    const computedReceivingAddress = spendingKeyPair.mulPublicKey(randomNumber).address;
    const step3End = performance.now();
    step3Duration = step3End - step3Start;

    // Step 4: Compare computed address with announcement receiver
    const step4Start = performance.now();
    const isForUser = computedReceivingAddress === getAddress(receiver);
    const step4End = performance.now();
    step4Duration = step4End - step4Start;

    return {
      isForUser,
      randomNumber,
      durations: {
        step1Duration,
        step2Duration,
        step3Duration,
        step4Duration
      }
    };
  } catch (err) {
    return {
      isForUser: false,
      randomNumber: '',
      durations: {
        step1Duration: 0,
        step2Duration: 0,
        step3Duration: 0,
        step4Duration: 0
      }
    };
  }
}



// Example test case to benchmark each operation in prepareSend
describe('Benchmark prepareSend Operations', function () {
  let sender: Wallet;
  let receiver: Wallet;
  let receivers: Wallet[] = [];
  let deployer: SignerWithAddress;
  let umbra: Umbra;
  let chainConfig: ChainConfig;

  const getEthBalance = async (address: string) => {
    return (await ethersProvider.getBalance(address)).toString();
  };
  const verifyEqualValues = (val1: BigNumberish, val2: BigNumberish) => {
    expect(BigNumber.from(val1).toString()).to.equal(BigNumber.from(val2).toString());
  };

  before(async () => {
    // Load signers' mnemonic and derivation path from hardhat config
    const accounts = hardhatConfig.networks?.hardhat?.accounts as HardhatNetworkHDAccountsUserConfig;
    const { mnemonic, path } = accounts;

    // Get the wallets of interest. The hardhat signers are generated by appending "/index" to the derivation path,
    // so we do the same to instantiate our wallets. Private key can now be accessed by `sender.privateKey`
    sender = ethers.Wallet.fromMnemonic(mnemonic as string, `${path as string}/${senderIndex}`);
    sender.connect(ethers.provider);
    receiver = ethers.Wallet.fromMnemonic(mnemonic as string, `${path as string}/${receiverIndex}`);
    receiver.connect(ethers.provider);
    for (let i = 0; i < 10; i++) {
      receivers.push(ethers.Wallet.fromMnemonic(mnemonic as string, `${path as string}/${i + 100}`));
      receivers[receivers.length - 1].connect(ethers.provider);
    }

    // Load other signers
    deployer = (await ethers.getSigners())[0]; // used for deploying contracts

    // Deploy Umbra
    // console.log('------------------------- DEPLOY ----------------------------');
    const toll = parseEther('0.1');
    const tollCollector = ethers.constants.AddressZero; // doesn't matter for these tests
    const tollReceiver = ethers.constants.AddressZero; // doesn't matter for these tests
    const umbraFactory = new Umbra__factory(deployer);
    const umbraContract = (await umbraFactory.deploy(toll, tollCollector, tollReceiver)) as UmbraContract;
    await umbraContract.deployTransaction.wait();
    // console.log('Deployed Umbra contract address:', umbraContract.address);

    // Deploy UmbraBatchSend
    const batchSendFactory = new ethers.ContractFactory(
      UMBRA_BATCH_SEND_ABI,
      { object: '0x60a060405234801561001057600080fd5b5060405161118038038061118083398101604081905261002f91610099565b61003833610049565b6001600160a01b03166080526100c9565b600080546001600160a01b038381166001600160a01b0319831681178455604051919092169283917f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e09190a35050565b6000602082840312156100ab57600080fd5b81516001600160a01b03811681146100c257600080fd5b9392505050565b60805161108e6100f2600039600081816102ef0152818161044c015261066b015261108e6000f3fe60806040526004361061005a5760003560e01c806380b2edd81161004357806380b2edd8146100895780638da5cb5b146100a9578063f2fde38b146100e257600080fd5b8063715018a61461005f5780637d703ead14610076575b600080fd5b34801561006b57600080fd5b50610074610102565b005b610074610084366004610e3d565b610116565b34801561009557600080fd5b506100746100a4366004610ede565b610647565b3480156100b557600080fd5b506000546040805173ffffffffffffffffffffffffffffffffffffffff9092168252519081900360200190f35b3480156100ee57600080fd5b506100746100fd366004610ede565b6106b3565b61010a61076c565b61011460006107ed565b565b47816000805b828210156102885760008173ffffffffffffffffffffffffffffffffffffffff1687878581811061014f5761014f610f02565b905060a0020160200160208101906101679190610ede565b73ffffffffffffffffffffffffffffffffffffffff1610156101b5576040517fba50f91100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b8686848181106101c7576101c7610f02565b905060a0020160200160208101906101df9190610ede565b91505b8686848181106101f4576101f4610f02565b905060a0020160400135816102099190610f60565b9050600183019250838310801561027457508173ffffffffffffffffffffffffffffffffffffffff1687878581811061024457610244610f02565b905060a00201602001602081019061025c9190610ede565b73ffffffffffffffffffffffffffffffffffffffff16145b6101e2576102828282610862565b5061011c565b60005b838110156105d05773eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee8787838181106102ba576102ba610f02565b905060a0020160200160208101906102d29190610ede565b73ffffffffffffffffffffffffffffffffffffffff160361044a577f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663beb9addf8989898581811061033c5761033c610f02565b905060a00201604001356103509190610f60565b89898581811061036257610362610f02565b61037892602060a0909202019081019150610ede565b8b8b8b8781811061038b5761038b610f02565b905060a00201606001358c8c888181106103a7576103a7610f02565b6040517fffffffff0000000000000000000000000000000000000000000000000000000060e08a901b16815273ffffffffffffffffffffffffffffffffffffffff90961660048701526024860194909452506044840191909152608060a090920201013560648201526084016000604051808303818588803b15801561042c57600080fd5b505af1158015610440573d6000803e3d6000fd5b50505050506105c8565b7f000000000000000000000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff1663b9bfabe18989898581811061049957610499610f02565b6104af92602060a0909202019081019150610ede565b8a8a868181106104c1576104c1610f02565b905060a0020160200160208101906104d99190610ede565b8b8b878181106104eb576104eb610f02565b905060a00201604001358c8c8881811061050757610507610f02565b905060a00201606001358d8d8981811061052357610523610f02565b6040517fffffffff0000000000000000000000000000000000000000000000000000000060e08b901b16815273ffffffffffffffffffffffffffffffffffffffff97881660048201529690951660248701525060448501929092526064840152608060a0909202010135608482015260a4016000604051808303818588803b1580156105ae57600080fd5b505af11580156105c2573d6000803e3d6000fd5b50505050505b60010161028b565b506105db3485610f79565b4714610613576040517f8e96d31f00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60405133907f5b4aa4fdb7b6e3ce88c3ccbf2e2c1d9a01b28e4234e107b644111c59de8b7cbe90600090a250505050505050565b61064f61076c565b6106b073ffffffffffffffffffffffffffffffffffffffff82167f00000000000000000000000000000000000000000000000000000000000000007fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff6108b9565b50565b6106bb61076c565b73ffffffffffffffffffffffffffffffffffffffff8116610763576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152602660248201527f4f776e61626c653a206e6577206f776e657220697320746865207a65726f206160448201527f646472657373000000000000000000000000000000000000000000000000000060648201526084015b60405180910390fd5b6106b0816107ed565b60005473ffffffffffffffffffffffffffffffffffffffff163314610114576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015260640161075a565b6000805473ffffffffffffffffffffffffffffffffffffffff8381167fffffffffffffffffffffffff0000000000000000000000000000000000000000831681178455604051919092169283917f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e09190a35050565b73ffffffffffffffffffffffffffffffffffffffff821673eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee146108b5576108b573ffffffffffffffffffffffffffffffffffffffff8316333084610abe565b5050565b80158061095957506040517fdd62ed3e00000000000000000000000000000000000000000000000000000000815230600482015273ffffffffffffffffffffffffffffffffffffffff838116602483015284169063dd62ed3e90604401602060405180830381865afa158015610933573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906109579190610f8c565b155b6109e5576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152603660248201527f5361666545524332303a20617070726f76652066726f6d206e6f6e2d7a65726f60448201527f20746f206e6f6e2d7a65726f20616c6c6f77616e636500000000000000000000606482015260840161075a565b60405173ffffffffffffffffffffffffffffffffffffffff8316602482015260448101829052610ab99084907f095ea7b300000000000000000000000000000000000000000000000000000000906064015b604080517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08184030181529190526020810180517bffffffffffffffffffffffffffffffffffffffffffffffffffffffff167fffffffff0000000000000000000000000000000000000000000000000000000090931692909217909152610b22565b505050565b60405173ffffffffffffffffffffffffffffffffffffffff80851660248301528316604482015260648101829052610b1c9085907f23b872dd0000000000000000000000000000000000000000000000000000000090608401610a37565b50505050565b6000610b84826040518060400160405280602081526020017f5361666545524332303a206c6f772d6c6576656c2063616c6c206661696c65648152508573ffffffffffffffffffffffffffffffffffffffff16610c2e9092919063ffffffff16565b805190915015610ab95780806020019051810190610ba29190610fa5565b610ab9576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152602a60248201527f5361666545524332303a204552433230206f7065726174696f6e20646964206e60448201527f6f74207375636365656400000000000000000000000000000000000000000000606482015260840161075a565b6060610c3d8484600085610c45565b949350505050565b606082471015610cd7576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152602660248201527f416464726573733a20696e73756666696369656e742062616c616e636520666f60448201527f722063616c6c0000000000000000000000000000000000000000000000000000606482015260840161075a565b6000808673ffffffffffffffffffffffffffffffffffffffff168587604051610d009190610feb565b60006040518083038185875af1925050503d8060008114610d3d576040519150601f19603f3d011682016040523d82523d6000602084013e610d42565b606091505b5091509150610d5387838387610d5e565b979650505050505050565b60608315610df4578251600003610ded5773ffffffffffffffffffffffffffffffffffffffff85163b610ded576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601d60248201527f416464726573733a2063616c6c20746f206e6f6e2d636f6e7472616374000000604482015260640161075a565b5081610c3d565b610c3d8383815115610e095781518083602001fd5b806040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161075a9190611007565b600080600060408486031215610e5257600080fd5b83359250602084013567ffffffffffffffff80821115610e7157600080fd5b818601915086601f830112610e8557600080fd5b813581811115610e9457600080fd5b87602060a083028501011115610ea957600080fd5b6020830194508093505050509250925092565b73ffffffffffffffffffffffffffffffffffffffff811681146106b057600080fd5b600060208284031215610ef057600080fd5b8135610efb81610ebc565b9392505050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b7f4e487b7100000000000000000000000000000000000000000000000000000000600052601160045260246000fd5b80820180821115610f7357610f73610f31565b92915050565b81810381811115610f7357610f73610f31565b600060208284031215610f9e57600080fd5b5051919050565b600060208284031215610fb757600080fd5b81518015158114610efb57600080fd5b60005b83811015610fe2578181015183820152602001610fca565b50506000910152565b60008251610ffd818460208701610fc7565b9190910192915050565b6020815260008251806020840152611026816040850160208701610fc7565b601f017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe016919091016040019291505056fea2646970667358221220b1edd7ff79c71bb95bc51b6f486ab6af1b7836fcf000ceb2ddd67570ba5a802564736f6c63430008100033' }, // prettier-ignore
      deployer
    );
    const batchSendContract = await batchSendFactory.deploy(umbraContract.address);
    await batchSendContract.deployTransaction.wait();
    // console.log('Deployed UmbraBatchSend contract address:', batchSendContract.address);

    // Get chainConfig based on most recent Sepolia block number to minimize scanning time
    const lastBlockNumber = await ethersProvider.getBlockNumber();
    chainConfig = {
      chainId: (await ethersProvider.getNetwork()).chainId,
      umbraAddress: umbraContract.address,
      batchSendAddress: batchSendContract.address,
      startBlock: lastBlockNumber,
      subgraphUrl: false, // prettier-ignore
    };

    // Get Umbra instance
    umbra = new Umbra(ethersProvider, chainConfig);
  });

  it('should benchmark all steps of prepareSend', async function () {
    const iterations = 100;
    const keyPairDurations: number[] = [];
    const randomDurations: number[] = [];
    const encryptionDurations: number[] = [];
    const compressDurations: number[] = [];
    const stealthDurations: number[] = [];
    const totalDurations: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const result = await benchmarkPrepareSend(umbra, receiver.publicKey.toString());
      keyPairDurations.push(result.durations.keyPairDuration);
      randomDurations.push(result.durations.randomDuration);
      encryptionDurations.push(result.durations.encryptionDuration);
      compressDurations.push(result.durations.compressDuration);
      stealthDurations.push(result.durations.stealthDuration);
      totalDurations.push(result.durations.totalDuration);
    }

    console.log(`\nAverages over ${iterations - 2} iterations (excluding the fastest and slowest):`);
    console.log(`KeyPair creation: ${computeAverageWithoutMinMax(keyPairDurations).toFixed(4)} ms`);
    console.log(`Random number generation: ${computeAverageWithoutMinMax(randomDurations).toFixed(4)} ms`);
    console.log(`Encryption: ${computeAverageWithoutMinMax(encryptionDurations).toFixed(4)} ms`);
    console.log(`Public key compression: ${computeAverageWithoutMinMax(compressDurations).toFixed(4)} ms`);
    console.log(`Stealth address computation: ${computeAverageWithoutMinMax(stealthDurations).toFixed(4)} ms`);
    console.log(`Total prepareSend execution time: ${computeAverageWithoutMinMax(totalDurations).toFixed(4)} ms`);
  });

  it('should benchmark scan function performance over multiple iterations', async function () {
    const iterations = 100;
    const avgStepTotalTimes: number[] = [];
    const totalScanTimes: number[] = [];
    const avgBatchRetrievalTimes: number[] = [];
    const avgStep1Times: number[] = [];
    const avgStep2Times: number[] = [];
    const avgStep3Times: number[] = [];
    const avgStep4Times: number[] = [];

    let stealthKeyPairs: KeyPair[] = [];
    let usedReceivers: Wallet[] = [];

    // Send some announcements to the receiver
    const { tx, stealthKeyPair } = await umbra.send(
      sender,
      ETH_ADDRESS,
      quantity,
      receiver!.publicKey,
      overrides
    );
    await tx.wait();
    verifyEqualValues(await getEthBalance(stealthKeyPair.address), quantity);
    stealthKeyPairs = [stealthKeyPair];
    usedReceivers = [receiver];

    for (let i = 0; i < usedReceivers.length; i++) {
      const expectedAmount = quantity;
      const receiver = usedReceivers[i];
      const stealthKeyPair = stealthKeyPairs[i];
      verifyEqualValues(await getEthBalance(stealthKeyPair.address), expectedAmount);

      for (let j = 0; j < iterations; j++) {
        const result = await benchmarkScan(umbra, receiver.publicKey, receiver.privateKey);
        totalScanTimes.push(result.durations.totalScanTime);
        avgBatchRetrievalTimes.push(result.durations.averageBatchRetrievalTime);
        avgStep1Times.push(result.durations.averageIsAnnouncementStep1);
        avgStep2Times.push(result.durations.averageIsAnnouncementStep2);
        avgStep3Times.push(result.durations.averageIsAnnouncementStep3);
        avgStep4Times.push(result.durations.averageIsAnnouncementStep4);
        avgStepTotalTimes.push(result.durations.averageIsAnnouncementTotal);
      }

      console.log(`\nAverages over ${iterations - 2} iterations (excluding the fastest and slowest):`);
      console.log(`Average batch retrieval time: ${computeAverageWithoutMinMax(avgBatchRetrievalTimes).toFixed(4)} ms`);
      console.log(`Average Step 1 (Get uncompressed public key): ${computeAverageWithoutMinMax(avgStep1Times).toFixed(4)} ms`);
      console.log(`Average Step 2 (Decrypt payload): ${computeAverageWithoutMinMax(avgStep2Times).toFixed(4)} ms`);
      console.log(`Average Step 3 (Compute receiving address): ${computeAverageWithoutMinMax(avgStep3Times).toFixed(4)} ms`);
      console.log(`Average Step 4 (Comparison): ${computeAverageWithoutMinMax(avgStep4Times).toFixed(4)} ms`);
      console.log(`Average total IsAnnouncementForUser runtime (Step 1+2+3+4): ${computeAverageWithoutMinMax(avgStepTotalTimes).toFixed(4)} ms`);
      console.log(`Total scan execution time: ${computeAverageWithoutMinMax(totalScanTimes).toFixed(4)} ms`);
    }
  });
});