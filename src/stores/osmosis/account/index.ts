import {
	ChainGetter,
	QueriesStore,
	MsgOpt,
	AccountSetBase,
	CosmosMsgOpts,
	HasCosmosQueries,
	AccountWithCosmos,
	QueriesSetBase,
	AccountSetOpts,
	CosmosAccount,
	CoinPrimitive,
} from '@keplr-wallet/stores';
import { Dec, DecUtils } from '@keplr-wallet/unit';
import { Currency } from '@keplr-wallet/types';
import { DeepReadonly } from 'utility-types';
import { HasOsmosisQueries } from '../query';
import deepmerge from 'deepmerge';

export interface HasOsmosisAccount {
	osmosis: DeepReadonly<OsmosisAccount>;
}

export interface OsmosisMsgOpts {
	readonly createPool: MsgOpt;
	readonly joinPool: MsgOpt & {
		shareCoinDecimals: number;
	};
	readonly exitPool: MsgOpt & {
		shareCoinDecimals: number;
	};
	readonly swapExactAmountIn: MsgOpt;
	readonly swapExactAmountOut: MsgOpt;
}

export class AccountWithCosmosAndOsmosis extends AccountSetBase<
	CosmosMsgOpts & OsmosisMsgOpts,
	HasCosmosQueries & HasOsmosisQueries
> {
	public readonly cosmos: DeepReadonly<CosmosAccount>;
	public readonly osmosis: DeepReadonly<OsmosisAccount>;

	static readonly defaultMsgOpts: CosmosMsgOpts & OsmosisMsgOpts = deepmerge(AccountWithCosmos.defaultMsgOpts, {
		createPool: {
			type: 'osmosis/gamm/create-pool',
			gas: 10000000,
		},
		joinPool: {
			type: 'osmosis/gamm/join-pool',
			gas: 10000000,
			shareCoinDecimals: 6,
		},
		exitPool: {
			type: 'osmosis/gamm/exit-pool',
			gas: 10000000,
			shareCoinDecimals: 6,
		},
		swapExactAmountIn: {
			type: 'osmosis/gamm/swap-exact-amount-in',
			gas: 10000000,
		},
		swapExactAmountOut: {
			type: 'osmosis/gamm/swap-exact-amount-out',
			gas: 10000000,
		},
	});

	constructor(
		protected readonly eventListener: {
			addEventListener: (type: string, fn: () => unknown) => void;
		},
		protected readonly chainGetter: ChainGetter,
		protected readonly chainId: string,
		protected readonly queriesStore: QueriesStore<QueriesSetBase & HasCosmosQueries & HasOsmosisQueries>,
		protected readonly opts: AccountSetOpts<CosmosMsgOpts & OsmosisMsgOpts>
	) {
		super(eventListener, chainGetter, chainId, queriesStore, opts);

		this.cosmos = new CosmosAccount(
			this as AccountSetBase<CosmosMsgOpts, HasCosmosQueries>,
			chainGetter,
			chainId,
			queriesStore
		);
		this.osmosis = new OsmosisAccount(
			this as AccountSetBase<OsmosisMsgOpts, HasOsmosisQueries>,
			chainGetter,
			chainId,
			queriesStore
		);
	}
}

export class OsmosisAccount {
	constructor(
		protected readonly base: AccountSetBase<OsmosisMsgOpts, HasOsmosisQueries>,
		protected readonly chainGetter: ChainGetter,
		protected readonly chainId: string,
		protected readonly queriesStore: QueriesStore<QueriesSetBase & HasOsmosisQueries>
	) {}

	/**
	 *
	 * @param swapFee The swap fee of the pool. Should set as the percentage. (Ex. 10% -> 10)
	 * @param assets Assets that will be provided pool initially. Token can be parsed as to primitive by convenience.
	 */
	async sendCreatePoolMsg(
		swapFee: string,
		assets: {
			// Int
			weight: string;
			// Ex) 10 atom.
			token: {
				currency: Currency;
				amount: string;
			};
		}[],
		memo: string = '',
		onFulfill?: (tx: any) => void
	) {
		const poolParams = {
			swapFee: new Dec(swapFee).quo(DecUtils.getPrecisionDec(2)).toString(),
			exitFee: new Dec(0).toString(),
		};

		const poolAssets: {
			weight: string;
			token: {
				denom: string;
				amount: string;
			};
		}[] = [];

		for (const asset of assets) {
			poolAssets.push({
				weight: asset.weight,
				token: {
					denom: asset.token.currency.coinMinimalDenom,
					amount: new Dec(asset.token.amount)
						.mul(DecUtils.getPrecisionDec(asset.token.currency.coinDecimals))
						.truncate()
						.toString(),
				},
			});
		}

		const msg = {
			type: this.base.msgOpts.createPool.type,
			value: {
				sender: this.base.bech32Address,
				poolParams,
				poolAssets,
			},
		};

		await this.base.sendMsgs(
			'createPool',
			[msg],
			{
				amount: [],
				gas: this.base.msgOpts.createPool.gas.toString(),
			},
			memo,
			tx => {
				if (tx.code == null || tx.code === 0) {
					// TODO: Refresh the pools list.

					// Refresh the balances
					const queries = this.queriesStore.get(this.chainId);
					queries.queryBalances.getQueryBech32Address(this.base.bech32Address).balances.forEach(bal => {
						if (assets.find(asset => asset.token.currency.coinMinimalDenom === bal.currency.coinMinimalDenom)) {
							bal.fetch();
						}
					});
				}

				if (onFulfill) {
					onFulfill(tx);
				}
			}
		);
	}

	async sendJoinPoolMsg(
		poolId: string,
		shareOutAmount: string,
		maxSlippage: string = '0',
		memo: string = '',
		onFulfill?: (tx: any) => void
	) {
		const queries = this.queries;

		await this.base.sendMsgs(
			'joinPool',
			async () => {
				const queryPool = queries.osmosis.queryGammPools.getObservableQueryPool(poolId);
				await queryPool.waitFreshResponse();

				const pool = queryPool.pool;
				if (!pool) {
					throw new Error('Unknown pool');
				}

				const maxSlippageDec = new Dec(maxSlippage).quo(DecUtils.getPrecisionDec(2));

				const estimated = pool.estimateJoinSwap(shareOutAmount, this.base.msgOpts.joinPool.shareCoinDecimals);

				const tokenInMaxs = maxSlippageDec.equals(new Dec(0))
					? null
					: estimated.tokenIns.map(tokenIn => {
							// TODO: Add the method like toPrimitiveCoin()?
							const dec = tokenIn.toDec();
							const amount = dec
								.mul(DecUtils.getPrecisionDec(tokenIn.currency.coinDecimals))
								.mul(new Dec(1).add(maxSlippageDec))
								.truncate();

							return {
								denom: tokenIn.currency.coinMinimalDenom,
								amount: amount.toString(),
							};
					  });

				return [
					{
						type: this.base.msgOpts.joinPool.type,
						value: {
							sender: this.base.bech32Address,
							poolId,
							shareOutAmount: new Dec(shareOutAmount)
								.mul(DecUtils.getPrecisionDec(this.base.msgOpts.joinPool.shareCoinDecimals))
								.truncate()
								.toString(),
							tokenInMaxs,
						},
					},
				];
			},
			{
				amount: [],
				gas: this.base.msgOpts.swapExactAmountIn.gas.toString(),
			},
			memo,
			tx => {
				if (tx.code == null || tx.code === 0) {
					// TODO: Refresh the pools list.

					// Refresh the balances
					const queries = this.queriesStore.get(this.chainId);
					queries.queryBalances.getQueryBech32Address(this.base.bech32Address).balances.forEach(bal => {
						// TODO: Explicitly refresh the share expected to be minted and provided to the pool.
						bal.fetch();
					});

					queries.osmosis.queryGammPools.getObservableQueryPool(poolId).fetch();
				}

				if (onFulfill) {
					onFulfill(tx);
				}
			}
		);
	}

	async sendSwapExactAmountInMsg(
		poolId: string,
		tokenIn: { currency: Currency; amount: string },
		tokenOutCurrency: Currency,
		maxSlippage: string = '0',
		memo: string = '',
		onFulfill?: (tx: any) => void
	) {
		const queries = this.queries;

		await this.base.sendMsgs(
			'swapExactAmountIn',
			async () => {
				const queryPool = queries.osmosis.queryGammPools.getObservableQueryPool(poolId);
				await queryPool.waitFreshResponse();

				const pool = queryPool.pool;
				if (!pool) {
					throw new Error('Unknown pool');
				}

				return [
					pool.makeSwapExactAmountInMsg(
						this.base.msgOpts.swapExactAmountIn,
						this.base.bech32Address,
						tokenIn,
						tokenOutCurrency,
						maxSlippage
					),
				];
			},
			{
				amount: [],
				gas: this.base.msgOpts.swapExactAmountIn.gas.toString(),
			},
			memo,
			tx => {
				if (tx.code == null || tx.code === 0) {
					// TODO: Refresh the pools list.

					// Refresh the balances
					const queries = this.queriesStore.get(this.chainId);
					queries.queryBalances.getQueryBech32Address(this.base.bech32Address).balances.forEach(bal => {
						if (
							bal.currency.coinMinimalDenom === tokenIn.currency.coinMinimalDenom ||
							bal.currency.coinMinimalDenom === tokenOutCurrency.coinMinimalDenom
						) {
							bal.fetch();
						}
					});
				}

				if (onFulfill) {
					onFulfill(tx);
				}
			}
		);
	}

	async sendSwapExactAmountOutMsg(
		poolId: string,
		tokenInCurrency: Currency,
		tokenOut: { currency: Currency; amount: string },
		maxSlippage: string = '0',
		memo: string = '',
		onFulfill?: (tx: any) => void
	) {
		const queries = this.queries;

		await this.base.sendMsgs(
			'swapExactAmountOut',
			async () => {
				const queryPool = queries.osmosis.queryGammPools.getObservableQueryPool(poolId);
				await queryPool.waitFreshResponse();

				const pool = queryPool.pool;
				if (!pool) {
					throw new Error('Unknown pool');
				}

				return [
					pool.makeSwapExactAmountOutMsg(
						this.base.msgOpts.swapExactAmountOut,
						this.base.bech32Address,
						tokenInCurrency,
						tokenOut,
						maxSlippage
					),
				];
			},
			{
				amount: [],
				gas: this.base.msgOpts.swapExactAmountIn.gas.toString(),
			},
			memo,
			tx => {
				if (tx.code == null || tx.code === 0) {
					// TODO: Refresh the pools list.

					// Refresh the balances
					const queries = this.queriesStore.get(this.chainId);
					queries.queryBalances.getQueryBech32Address(this.base.bech32Address).balances.forEach(bal => {
						if (
							bal.currency.coinMinimalDenom === tokenInCurrency.coinMinimalDenom ||
							bal.currency.coinMinimalDenom === tokenOut.currency.coinMinimalDenom
						) {
							bal.fetch();
						}
					});
				}

				if (onFulfill) {
					onFulfill(tx);
				}
			}
		);
	}

	async sendExitPoolMsg(
		poolId: string,
		shareInAmount: string,
		maxSlippage: string = '0',
		memo: string = '',
		onFulfill?: (tx: any) => void
	) {
		const queries = this.queries;

		await this.base.sendMsgs(
			'exitPool',
			async () => {
				const queryPool = queries.osmosis.queryGammPools.getObservableQueryPool(poolId);
				await queryPool.waitFreshResponse();

				const pool = queryPool.pool;
				if (!pool) {
					throw new Error('Unknown pool');
				}

				const estimated = pool.estimateExitSwap(shareInAmount, this.base.msgOpts.exitPool.shareCoinDecimals);

				const maxSlippageDec = new Dec(maxSlippage).quo(DecUtils.getPrecisionDec(2));

				const tokenOutMins = maxSlippageDec.equals(new Dec(0))
					? null
					: estimated.tokenOuts.map(tokenOut => {
							return {
								denom: tokenOut.currency.coinMinimalDenom,
								amount: tokenOut
									.toDec()
									.mul(new Dec(1).sub(maxSlippageDec))
									.mul(DecUtils.getPrecisionDec(tokenOut.currency.coinDecimals))
									.truncate()
									.toString(),
							};
					  });

				return [
					{
						type: this.base.msgOpts.exitPool.type,
						value: {
							sender: this.base.bech32Address,
							poolId: pool.id,
							shareInAmount: new Dec(shareInAmount)
								.mul(DecUtils.getPrecisionDec(this.base.msgOpts.exitPool.shareCoinDecimals))
								.truncate()
								.toString(),
							tokenOutMins,
						},
					},
				];
			},
			{
				amount: [],
				gas: this.base.msgOpts.exitPool.gas.toString(),
			},
			memo,
			tx => {
				if (tx.code == null || tx.code === 0) {
					// Refresh the balances
					const queries = this.queriesStore.get(this.chainId);
					queries.queryBalances.getQueryBech32Address(this.base.bech32Address).fetch();

					// Refresh the pool
					queries.osmosis.queryGammPools.getObservableQueryPool(poolId).fetch();
				}

				if (onFulfill) {
					onFulfill(tx);
				}
			}
		);
	}

	protected get queries(): DeepReadonly<QueriesSetBase & HasOsmosisQueries> {
		return this.queriesStore.get(this.chainId);
	}
}
