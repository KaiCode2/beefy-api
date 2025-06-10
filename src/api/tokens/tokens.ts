import { getSingleChainVaults, getVaultsByChain } from '../stats/getMultichainVaults';
import { getChainNewBoosts } from '../boosts/getBoosts';
import { addressBook } from '../../../packages/address-book/src/address-book';
import Token from '../../../packages/address-book/src/types/token';
import { MULTICHAIN_ENDPOINTS } from '../../constants';
import { serviceEventBus } from '../../utils/ServiceEventBus';
import { ApiChain, isApiChain, toApiChain } from '../../utils/chain';
import { ChainTokens, TokenEntity, TokenErc20, TokenNative, TokensByChain } from './types';
import { mapValues } from 'lodash';
import { Address, getAddress } from 'viem';

const tokensByChain: Partial<TokensByChain> = {};

export function getTokenById(id: string, chainId: ApiChain): TokenEntity | undefined {
  const address = tokensByChain[chainId]?.byId[id];
  if (address) {
    return getTokenByAddress(address, chainId);
  }
}

export function getTokenByAddress(address: string, chainId: ApiChain): TokenEntity | undefined {
  return tokensByChain[chainId]?.byAddress[address.toLowerCase()];
}

export function getTokensForChain(chainId: ApiChain): Record<string, TokenEntity> {
  return tokensByChain[chainId]?.byAddress || {};
}

export function getTokensForChainById(chainId: ApiChain): Record<string, TokenEntity> | undefined {
  const idMap = tokensByChain[chainId]?.byId;
  if (idMap) {
    return mapValues(idMap, address => getTokenByAddress(address, chainId));
  }
}

export function getAllTokensByChain(): Partial<TokensByChain> {
  return tokensByChain;
}

export function getTokenNative(chainId: ApiChain): TokenNative {
  const native = getTokenById('NATIVE', chainId);
  if (!native || !isTokenNative(native)) {
    throw new Error(`No native token found for chain ${chainId}`);
  }

  return native;
}

export function getTokenWrappedNative(chainId: ApiChain): TokenErc20 {
  const wnative = getTokenById('WNATIVE', chainId);
  if (!wnative || !isTokenErc20(wnative)) {
    throw new Error(`No wnative token found for chain ${chainId}`);
  }

  return wnative;
}

export function getTokenFees(chainId: ApiChain): TokenErc20 {
  const fees = getTokenById('FEES', chainId);
  if (!fees || !isTokenErc20(fees)) {
    throw new Error(`No fees token found for chain ${chainId}`);
  }

  return fees;
}

export function wrappedToNative(token: TokenEntity): TokenEntity {
  const wnative = getTokenWrappedNative(token.chainId);

  if (areTokensEqual(token, wnative)) {
    return getTokenNative(token.chainId);
  }

  return token;
}

export function nativeToWrapped(token: TokenEntity): TokenErc20 {
  if (isTokenNative(token)) {
    return getTokenWrappedNative(token.chainId);
  }

  return token;
}

export function isTokenNative(token: TokenEntity): token is TokenNative {
  return token.type === 'native';
}

export function isTokenErc20(token: TokenEntity): token is TokenErc20 {
  return token.type === 'erc20';
}

export function areTokensEqual(tokenA: TokenEntity, tokenB: TokenEntity): boolean {
  return (
    tokenA.chainId === tokenB.chainId && tokenA.address === tokenB.address && tokenA.type === tokenB.type
  );
}

async function fetchVaultTokensForChain(chainId: ApiChain): Promise<TokenEntity[]> {
  const vaults = getVaultsByChain(chainId) || [];

  return vaults.reduce((tokens: TokenEntity[], vault) => {
    // Native comes from address book
    if (vault.tokenAddress && vault.type !== 'cowcentrated') {
      tokens.push({
        type: 'erc20',
        id: vault.token,
        symbol: vault.token,
        name: vault.token,
        chainId,
        oracle: vault.oracle,
        oracleId: vault.oracleId,
        address: vault.tokenAddress,
        decimals: vault.tokenDecimals,
      });
    }

    // Skip natives and mooTokens
    if (
      vault.earnedTokenAddress &&
      vault.earnedTokenAddress !== 'native' &&
      vault.earnedTokenAddress !== vault.earnContractAddress
    ) {
      tokens.push({
        type: 'erc20',
        id: vault.earnedToken,
        symbol: vault.earnedToken,
        name: vault.earnedToken,
        chainId,
        oracle: 'tokens', // ???
        oracleId: vault.earnedToken, // this is oracle of deposit token not the receipt/share token...
        address: vault.earnedTokenAddress,
        decimals: vault.earnedTokenDecimals || 18,
      });
    }

    return tokens;
  }, []);
}

async function fetchBoostTokensForChain(chainId: ApiChain): Promise<TokenEntity[]> {
  const boosts = getChainNewBoosts(chainId) || [];
  const vaultAddresses = new Set(
    (getSingleChainVaults(chainId) || []).map(vault => vault.earnContractAddress)
  );

  return boosts.reduce((tokens: TokenEntity[], boost) => {
    for (const reward of boost.rewards) {
      if (
        reward.type === 'token' &&
        reward.address &&
        reward.address !== 'native' &&
        !vaultAddresses.has(reward.address as Address)
      ) {
        tokens.push({
          type: 'erc20',
          id: reward.symbol,
          symbol: reward.symbol,
          name: reward.symbol,
          chainId: reward.chainId ? toApiChain(reward.chainId) : chainId,
          oracleId: reward.oracleId || reward.symbol,
          oracle: reward.oracle || 'tokens',
          address: reward.address,
          decimals: reward.decimals || 18,
        });
      }
    }
    return tokens;
  }, []);
}

async function fetchAddressBookTokensForChain(chainId: ApiChain): Promise<TokenEntity[]> {
  const chainBook = addressBook[chainId];
  if (!chainBook) {
    console.error(`Missing address book for ${chainId}`);
    return [];
  }
  const abTokens: Record<string, Token> = chainBook.tokens;
  if (!abTokens || !Object.keys(abTokens).length || !abTokens.WNATIVE) {
    console.warn(`No address book tokens found for chain ${chainId}`);
    return [];
  }

  const nativeSymbol = chainBook.native.symbol;
  const nativeOracleId = chainBook.native.oracleId;

  return Object.entries(abTokens).reduce((tokens: TokenEntity[], [id, token]) => {
    if (id.toLowerCase() === nativeSymbol.toLowerCase()) {
      // add native under native id (e.g. ETH)
      tokens.push({
        type: 'native',
        id,
        symbol: nativeSymbol,
        name: token.name,
        chainId,
        oracle: 'tokens',
        oracleId: nativeOracleId,
        address: 'native',
        decimals: token.decimals,
        bridge: 'native',
      });
    } else {
      tokens.push({
        type: 'erc20',
        id,
        symbol: token.symbol,
        name: token.name,
        chainId,
        oracle: token.oracle || 'tokens',
        oracleId: token.oracleId || id,
        address: token.address,
        decimals: token.decimals,
        ...(token.bridge ? { bridge: token.bridge } : {}),
        ...(token.staked ? { staked: token.staked } : {}),
      });

      if (id === 'WNATIVE') {
        // add NATIVE from WNATIVE
        tokens.push({
          type: 'native',
          id: 'NATIVE',
          symbol: nativeSymbol,
          name: token.name,
          chainId,
          oracle: 'tokens',
          oracleId: nativeOracleId,
          address: 'native',
          decimals: token.decimals,
          bridge: 'native',
        });
      }
    }

    return tokens;
  }, []);
}

function addToken(
  token: TokenEntity,
  byId: Record<TokenEntity['id'], TokenEntity['address']>,
  byAddress: Record<TokenEntity['address'], TokenEntity>
) {
  const addressLower = token.address.toLowerCase();

  // Map id to address
  if (byId[token.id] === undefined) {
    byId[token.id] = addressLower;
  }

  // Map address to token
  if (byAddress[addressLower] === undefined) {
    if (token.type === 'native') {
      byAddress[addressLower] = token;
    } else {
      byAddress[addressLower] = {
        ...token,
        address: getAddress(token.address),
      };
    }
  } else {
    // Merge extra info
    const existing = byAddress[addressLower];
    if (!existing.bridge && token.bridge) {
      existing.bridge = token.bridge;
    }
  }
}

async function fetchTokensForChain(chainId: ApiChain): Promise<ChainTokens> {
  if (!isApiChain(chainId)) {
    throw new Error(`Invalid chain ${chainId}`);
  }

  const [vaultTokens, boostTokens, abTokens] = await Promise.all([
    fetchVaultTokensForChain(chainId),
    fetchBoostTokensForChain(chainId),
    fetchAddressBookTokensForChain(chainId),
  ]);

  const byId: Record<TokenEntity['id'], TokenEntity['address']> = {};
  const byAddress: Record<TokenEntity['address'], TokenEntity> = {};

  [...vaultTokens, ...boostTokens, ...abTokens].forEach(token => addToken(token, byId, byAddress));

  // Address book oracle id and symbol takes precedence now
  abTokens.forEach(token => {
    const addressKey = token.address.toLowerCase();
    byAddress[addressKey].oracleId = token.oracleId;
    byAddress[addressKey].symbol = token.symbol;
  });

  if (!byId['NATIVE']) {
    throw new Error(`No native token loaded for chain ${chainId}`);
  }

  if (!byId['WNATIVE']) {
    throw new Error(`No wnative token loaded for chain ${chainId}`);
  }

  return { byId, byAddress };
}

export async function initTokenService() {
  // Wait for boost and vault services to be ready
  await Promise.all([
    serviceEventBus.waitForFirstEvent('vaults/updated'),
    serviceEventBus.waitForFirstEvent('boosts/updated'),
  ]);

  // Update token list
  await updateTokens();
}

async function updateTokens() {
  try {
    console.log('> Updating token service');
    const chains = Object.keys(MULTICHAIN_ENDPOINTS) as ApiChain[];
    const byChain = await Promise.all(chains.map(chainId => fetchTokensForChain(chainId)));

    chains.forEach((chainId, i) => {
      tokensByChain[chainId] = byChain[i];
      serviceEventBus.emit(`tokens/${chainId}/ready`);
    });

    serviceEventBus.emit('tokens/updated');

    console.log('> Token service updated');
  } catch (err) {
    console.error('> Token service update failed', err);
  } finally {
    // Update tokens whenever boosts or vaults update
    Promise.race([
      serviceEventBus.waitForNextEvent('vaults/updated'),
      serviceEventBus.waitForNextEvent('boosts/updated'),
    ]).then(updateTokens);
  }
}
