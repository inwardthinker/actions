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
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { createCanvas, loadImage } from 'canvas';
import { encodeFunctionData } from 'viem';
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
      gameId: "1001000000001594957394",
      conditionId: "100110010000000015949573940000000000000383398806",
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
      label: 'Place Bet',
      parameters: [
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
              value: outcome.outcomeId,
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
          label: 'Enter bet amount (USD)',
          required: true,
          pattern: '^[0-9]+(\.[0-9]+)?$',
        },
      ],
    };

    const base64Image = await generateDynamicImage(matchData)

    const payload = {
      title: `${matchData.homeTeam.name} vs ${matchData.awayTeam.name}`,
      icon: `data:image/png;base64,${base64Image}` || "https://dev-avatars.azuro.org/images/33/1001000000001595522983/Korona Kielce.png",
      description: `${matchData.sport.name} > ${matchData.league.name}
${new Date(parseInt(matchData.startsAt || '0') * 1000).toLocaleString('UTC', {
        hour12: true,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      })} UTC

Bet on your favorite team via SOL now!

Specify your non - CEX polygon wallet address below, correctly.Redeem winnings at sportsbooks.dgbet.fun / bets after the game ends.`,
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

    // Validate the client provided input
    let account: PublicKey;
    try {
      account = new PublicKey(body.account);
    } catch (err) {
      return new Response('Invalid "account" provided', {
        status: 400,
        headers,
      });
    }

    const fromChainId = 7565164; // Assuming Solana chain ID for source chain
    const fromTokenAddress = 'So11111111111111111111111111111111111111112'; // Solana native token address (assuming SOL)
    const rawAmount = amount; // Convert amount from Solana to Polygon (USD to MATIC conversion logic)
    const currentTime = Math.floor(Date.now() / 1000);
    const rawDeadline = currentTime + 2000;
    const affiliate = '0x39861ad41e6e4c43ed8c3423be5ef6faf91a3f84'; // Affiliate address
    const minOdds = '4622743913683'; // Minimum odds for the bet
    const betData = "..."

    const params = new URLSearchParams({
      dstChainId: '137',
      srcChainOrderAuthorityAddress: body?.account as string, // Solana user address
      prependOperatingExpenses: 'false',
      srcChainId: String(fromChainId),
      srcChainTokenIn: fromTokenAddress, // Solana token address
      srcChainTokenInAmount: String(rawAmount),
      dstChainTokenOut: process.env.POLYGONAMOY_TOKEN_ADDRESS || '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
      dstChainTokenOutAmount: 'auto',
      dstChainTokenOutRecipient: walletAddress, // Polygon user address
      dstChainOrderAuthorityAddress: walletAddress, // Polygon user address
      externalCall: JSON.stringify({
        version: 'evm_1',
        fields: {
          to: process.env.LP_ADDRESS, // Azuro LP contract address
          data: encodeFunctionData({
            abi: lpAbi,
            functionName: 'betFor',
            args: [
              walletAddress,
              process.env.CORE_ADDRESS,
              rawAmount,
              rawDeadline,
              {
                affiliate, // Affiliate address
                minOdds, // Minimum odds
                data: betData, // Encoded bet data
              },
            ],
          }),
        },
      }),
    });

    const deBridgeCreateTxResponse = await fetch(`https://api.dln.trade/v1.0/dln/order/create-tx?${params}`);
    const { orderId, estimation, tx, fixFee }: any = await deBridgeCreateTxResponse.json();
    console.log(orderId, estimation, tx, fixFee, "betting", deBridgeCreateTxResponse)

    const connection = new Connection(
      process.env.SOLANA_RPC! || clusterApiUrl('devnet'),
    );
    // console.log(connection, "await", clusterApiUrl('devnet'))

    const minimumBalance = await connection.getMinimumBalanceForRentExemption(0);
    // console.log(minimumBalance, "min")
    if (amount * LAMPORTS_PER_SOL < minimumBalance) {
      throw `Account may not be rent exempt: ${toPubkey.toBase58()}`;
    }

    // get the latest blockhash amd block height
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    // create a legacy transaction
    const transaction = new Transaction({
      feePayer: new PublicKey(body.account),
      blockhash,
      lastValidBlockHeight,
    }).add({
      programId: new PublicKey("tx.to"),
      keys: [{ pubkey: toPubkey, isSigner: false, isWritable: true }],
      data: Buffer.from("tx.data.slice(2)", 'hex'),
    })

    // const transaction = new Transaction({
    //   feePayer: new PublicKey(body.account),
    //   recentBlockhash: (await connection.getRecentBlockhash()).blockhash,
    // }).add({
    //   programId: new PublicKey(tx.to),
    //   keys: [{ pubkey: toPubkey, isSigner: false, isWritable: true }],
    //   data: Buffer.from(tx.data.slice(2), 'hex'),
    // });

    const payload: ActionPostResponse = await createPostResponse({
      fields: {
        transaction,
        message: `Bet placed successfully with a fee of ${fixFee}`,
      },
    });

    return Response.json(payload, {
      headers,
    });
  } catch (err) {
    console.log(err);
    let message = 'An unknown error occurred';
    if (typeof err == 'string') message = err;
    return new Response(message, {
      status: 400,
      headers,
    });
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
    throw 'Invalid input query parameter: to';
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
  const width = 800;
  const height = 600;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background color
  ctx.fillStyle = '#454545';
  ctx.fillRect(0, 0, width, height);

  // Sport and League
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = '30px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(matchData.sport.name, width / 2, 120);
  ctx.fillStyle = "white";
  ctx.font = '40px Arial';
  ctx.fillText(matchData.league.name, width / 2, 170);

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

  console.log('both logos generated', awayLogo, homeLogo, matchData?.awayTeam, matchData?.homeTeam)
  // Draw team logos
  ctx.drawImage(homeLogo, 50, 200, 200, 200);
  ctx.drawImage(awayLogo, 550, 200, 200, 200);

  // Draw vs text
  ctx.fillStyle = 'white';
  ctx.font = '50px Arial';
  ctx.fillText('V', width / 2, 320);

  // Draw team names
  ctx.font = '40px Arial';
  ctx.fillText(matchData.homeTeam.name, 150, 460);
  ctx.fillText(matchData.awayTeam.name, 650, 460);

  const buffer = canvas.toBuffer('image/png');
  const base64Image = buffer.toString('base64');
  return base64Image;
}