import { lpAbi } from '@/app/abis/lpAbi';
import { gql, useQuery } from '@apollo/client';
import { getMarketName } from '@azuro-org/dictionaries';
import { useGame } from '@azuro-org/sdk';
import {
  ActionPostResponse,
  createPostResponse,
  ActionGetResponse,
  ActionPostRequest,
  createActionHeaders,
  LinkedAction,
} from '@solana/actions';
import {
  clusterApiUrl,
  ComputeBudgetProgram,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { createCanvas, loadImage } from 'canvas';
import { encodeAbiParameters, encodeFunctionData, parseAbiParameters, parseUnits, zeroAddress } from 'viem';
import { useReadContract, useWriteContract } from 'wagmi';
const FALLBACK_IMAGE_PATH = "src/app/assets/placeholder.svg"

const headers = createActionHeaders();
const allowedOrigin = "https://dial.to";

export const GET = async (req: Request) => {
  try {

    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    headers.set('Access-Control-Allow-Origin', allowedOrigin);  // Allowing CORS
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');

    const requestUrl = new URL(req.url);
    const { toPubkey } = validatedQueryParams(requestUrl);

    const baseHref = new URL(
      `/api/actions/crosschain-bet?to=${toPubkey.toBase58()}`,
      requestUrl.origin,
    ).toString();

    // Initialize matchData with dynamic properties
    const matchData: {
      gameId: string;
      conditionId: string;
      outcomes: any[];
      homeTeam: any;
      awayTeam: any;
      sport?: any;
      league?: any;
      startsAt?: string;
      [key: string]: any; // Allow any additional properties
    } = {
      gameId: "1001000000001595771060",
      conditionId: "100110010000000015957710600000000000000386328164",
      outcomes: [],
      homeTeam: {},
      awayTeam: {},
    };

    const query = `
      query Game($gameId: String!, $conditionId: String!) {
        games(where: {gameId: $gameId}) {
          gameId
          league { name }
          sport { name }
          startsAt
          title
          status
          conditions(where: {conditionId: $conditionId}) {
            conditionId
            outcomes {
              currentOdds
              outcomeId
              sortOrder
            }
          }
          participants {
            image
            name
            sortOrder
          }
        }
      }
    `;
    
    const variables = { gameId: matchData.gameId, conditionId: matchData.conditionId };
    
    const proxyResponse = await fetch('https://thegraph.azuro.org/subgraphs/name/azuro-protocol/azuro-api-polygon-v3', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Don't include 'Origin' header here, as it's not needed and might cause CORS issues
      },
      body: JSON.stringify({
        query: query,
        variables: variables
      }),
    });
    
    if (!proxyResponse.ok) {
      throw new Error(`API call failed with status ${proxyResponse.status}`);
    }
    
    const data = await proxyResponse.json();
    const game = data?.data?.games[0];
    console.log(game?.status, "status")

    if (game) {
      // Update matchData with fetched data
      Object.assign(matchData, {
        sport: game.sport,
        league: game.league,
        startsAt: game.startsAt,
        status: game.status,
        title: game.title,
        slug: game.slug,
        awayTeam: game?.participants[1],
        homeTeam: game?.participants[0],
        outcomes: game?.conditions[0]?.outcomes,
        participants: game?.participants,
      });
    }
    const marketName = getMarketName({ outcomeId: matchData?.outcomes[0]?.outcomeId })

    const bettingAction = {
      href: `${baseHref}&amount={amount}&gameId=${matchData?.gameId}&conditionId=${matchData?.conditionId}`,
      label: game?.status === "Created" ? 'Place Bet' : 'Market Closed',
      parameters: game?.status === "Created" && [
        {
          type: 'radio',
          name: 'betOption',
          label: marketName || 'Full Time Result',
          required: true,
          options: matchData.outcomes.map((outcome: any) => {
            const participantName = matchData.participants?.find(
              (participant: any) => participant.sortOrder === outcome.sortOrder
            )?.name || 'Draw';

            return {
              label: `${participantName} (Odds: ${outcome.currentOdds})`,
              value: `${outcome.outcomeId + '__' + outcome.currentOdds}`,
            };
          }),
        },
        {
          type: 'text',
          name: 'walletAddress',
          label: 'Your Polygon wallet address',
          required: true,
          pattern: '^0x[a-fA-F0-9]{40}$',
        },
        {
          type: 'text',
          name: 'amount',
          label: 'Enter bet amount (SOL)',
          required: true,
          pattern: '^[0-9]+(\.[0-9]+)?$',
        },
      ],
    };

    const base64Image = await generateDynamicImage(matchData)

    const payload = {
      title: `${matchData.homeTeam.name} vs ${matchData.awayTeam.name} `,
      disabled: game?.status !== "Created",
      icon: `data: image / png; base64, ${base64Image} ` || "https://dev-avatars.azuro.org/images/33/1001000000001595522983/Korona Kielce.png",
      description: `${matchData.sport.name} > ${matchData.league.name}
${new Date(parseInt(matchData.startsAt || '0') * 1000).toLocaleString('UTC', {
        hour12: true,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      })
        } UTC

Bet on your favorite team via SOL now!

Specify your non - CEX polygon wallet address below, correctly. Redeem winnings at sportsbooks.dgbet.fun/bets after the game ends.`,
      label: 'Bet on your favorite team via SOL now!',
      links: {
        actions: [bettingAction],
      },
    };

    return new Response(JSON.stringify(payload), {
      headers,
    });
  } catch (err) {
    console.error(err);
    return new Response(`${err} `, {
      status: 400,
      headers: {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': allowedOrigin,
      }
    });
  }
};

export const OPTIONS = async (req: Request) => {
  return new Response(null, { headers });
};

export const POST = async (req: Request) => {
  try {
    const requestUrl = new URL(req.url);
    const body: ActionPostRequest = await req.json();
    const { amount, toPubkey, gameId, conditionId } = validatedQueryParams(requestUrl, body);

    const walletAddress = (body?.data as unknown as { walletAddress: string })?.walletAddress;
    const betOption = (body?.data as unknown as { betOption: string })?.betOption;

    // Validate the client provided input
    let account: PublicKey;
    try {
      account = new PublicKey(body.account);
    } catch (err) {
      return new Response('Invalid "account" provided', { status: 400, headers });
    }

    const fromChainId = 7565164; // Solana chain ID
    const fromTokenAddress = 'So11111111111111111111111111111111111111112'; // Solana native token address (SOL)
    const rawAmount = BigInt(amount * LAMPORTS_PER_SOL); // Convert SOL to lamports
    const currentTime = Math.floor(Date.now() / 1000);
    const rawDeadline = currentTime + 2000;
    const affiliate = '0x39861ad41e6e4c43ed8c3423be5ef6faf91a3f84'; // Affiliate address

    // Prepare DeBridge API parameters
    const params = new URLSearchParams({
      dstChainId: '137', // Polygon
      srcChainOrderAuthorityAddress: account.toBase58(),
      prependOperatingExpenses: 'false',
      srcChainId: String(fromChainId),
      srcChainTokenIn: fromTokenAddress,
      srcChainTokenInAmount: rawAmount.toString(),
      dstChainTokenOut: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
      dstChainTokenOutAmount: 'auto',
      dstChainTokenOutRecipient: walletAddress,
      dstChainOrderAuthorityAddress: walletAddress,
    });

    const deBridgeCreateTxResponse = await fetch(`https://api.dln.trade/v1.0/dln/order/create-tx?${params}`);
    const { orderId, estimation, tx, fixFee }: any = await deBridgeCreateTxResponse.json();
    const amountFinal = Math.floor(parseFloat(estimation?.dstChainTokenOut?.recommendedAmount));
    const [outcomeId, currentOdds] = betOption.split(/__/)
    const data = encodeAbiParameters(parseAbiParameters("uint256, uint64"), [
      BigInt(conditionId),
      BigInt(outcomeId),
    ]);
    const slippage = 5;
    const minOdds = 1 + ((Number(currentOdds) - 1) * (100 - Number(slippage))) / 100;
    const oddsDecimals = 12; // in current version of protocol odds has 12 decimals
    const rawMinOdds = parseUnits(
      minOdds.toFixed(oddsDecimals),
      oddsDecimals
    );

    const externalCall = JSON.stringify({
      version: 'evm_1',
      fields: {
        to: process.env.LP_ADDRESS, // Azuro LP contract address
        data: encodeFunctionData({
          abi: lpAbi,
          functionName: 'betFor',
          args: [
            walletAddress,
            process.env.CORE_ADDRESS,
            amountFinal,
            rawDeadline,
            {
              affiliate: affiliate,
              data,
              minOdds: rawMinOdds,
            },
          ],
        })
      },
    });

    // Update DeBridge API parameters with externalCall
    // params.set('externalCall', externalCall);
    params.set('dstChainTokenOutAmount', String(amountFinal))
    // params.set('srcChainTokenInAmount', 'auto')

    // Make the final API call to DeBridge with updated parameters
    const finalDeBridgeResponse = await fetch(`https://api.dln.trade/v1.0/dln/order/create-tx?${params}`);
    const finalDeBridgeData: any = await finalDeBridgeResponse.json();

    const connection = new Connection(process.env.SOLANA_RPC! || 'https://api.devnet.solana.com');

    const minimumBalance = await connection.getMinimumBalanceForRentExemption(0);
    if (rawAmount < BigInt(minimumBalance)) {
      throw `Account may not be rent exempt: ${account.toBase58()}`;
    }
    // Create a Solana transaction
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const transaction = new Transaction({
      feePayer: account,
      blockhash,
      lastValidBlockHeight,
    })
    const computeUnitsPrice = ComputeBudgetProgram.setComputeUnitLimit({
      units: 100000,
    })
    const computeUnitsLimit = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 1,
    })

    const fee = await transaction.getEstimatedFee(connection);

    const mainTransaction = transaction.add(
      {
        programId: new PublicKey(account),
        keys: [{ pubkey: toPubkey, isSigner: false, isWritable: true }],
        data: Buffer.from(finalDeBridgeData.tx.data.slice(2), 'hex'),
      }
    );
    console.log(fee, "fee")

    const payload: ActionPostResponse = await createPostResponse({
      fields: {
        transaction: mainTransaction,
        message: `Bet placed successfully with a fee of ${finalDeBridgeData.fixFee} & orderId ${finalDeBridgeData?.orderId}`,
      },
    });

    return Response.json(payload, { headers });
  } catch (err) {
    console.error(err);
    let message = 'An unknown error occurred';
    if (typeof err == 'string') message = err;
    return new Response(message, { status: 400, headers });
  }
};

function validatedQueryParams(requestUrl: URL, body?: any) {
  // console.log(requestUrl, "requesturl", body)
  let toPubkey: PublicKey = new PublicKey(
    body?.account || "FWXHZxDocgchBjADAxSuyPCVhh6fNLT7DUggabAsuz1y"
  );
  let amount: number = 0.1;
  let gameId: any;
  let conditionId: any;

  try {
    if (body?.account) {
      toPubkey = new PublicKey(body?.account!);
    }
  } catch (err) {
    throw 'Invalid input query parameter: account';
  }

  try {
    if (requestUrl.searchParams.get('amount')) {
      amount = parseFloat(requestUrl.searchParams.get('amount')!);
    }
    if (requestUrl.searchParams.get('gameId')) {
      gameId = requestUrl.searchParams.get('gameId')!;
    }
    if (requestUrl.searchParams.get('conditionId')) {
      conditionId = requestUrl.searchParams.get('conditionId')!;
    }

    if (amount <= 0) throw 'amount is too small';
  } catch (err) {
    throw `Invalid input query parameter: ${amount}`;
  }

  return {
    amount,
    gameId,
    toPubkey,
    conditionId
  };
}

async function generateDynamicImage(matchData: any) {

  // Create the canvas
  const width = 490;
  const height = 450;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background color
  ctx.fillStyle = '#454545';
  ctx.fillRect(0, 0, width, height);

  // Sport and League
  ctx.fillStyle = '#878787';
  ctx.font = '20px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(matchData.sport.name, width / 2, 120);
  ctx.fillStyle = "white";
  ctx.font = '24px Arial';
  ctx.fillText(matchData.league.name, width / 2, 155);

  // Load team logos
  let homeLogo, awayLogo;
  try {
    homeLogo = await loadImage(matchData.homeTeam.image);
  } catch (err) {
    console.error(`Failed to load home team image: ${err}`);
    homeLogo = await loadImage(`${FALLBACK_IMAGE_PATH}`); // Use a placeholder image
  }

  try {
    awayLogo = await loadImage(matchData.awayTeam.image);
  } catch (err) {
    console.error(`Failed to load away team image: ${err}`);
    awayLogo = await loadImage(`${FALLBACK_IMAGE_PATH}`); // Use a placeholder image
  }

  // Draw team logos
  ctx.drawImage(homeLogo, 40, 190, 120, 120);
  ctx.drawImage(awayLogo, 315, 190, 120, 120);

  // Draw vs text
  ctx.fillStyle = 'white';
  ctx.font = '35px Arial';
  ctx.fillText('V', width / 2, 280);

  // Draw team names
  ctx.font = '25px Arial';
  ctx.fillText(matchData.homeTeam.name, 100, 350);
  ctx.fillText(matchData.awayTeam.name, 375, 350);

  const buffer = canvas.toBuffer('image/png');
  const base64Image = buffer.toString('base64');
  return base64Image;
}