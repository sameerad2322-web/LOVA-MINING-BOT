import { Address, beginCell, Cell } from '@ton/core';

/**
 * Converts a decimal token amount (e.g. 0.05) to integer nano/base units using BigInt.
 */
export function toJettonBaseUnits(amount: number, decimals: number): bigint {
  const fixed = amount.toFixed(decimals);
  const [whole, frac = ''] = fixed.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

/**
 * Builds a TEP-74 Jetton Transfer payload (opcode 0x0f8a7ea5) encoded as base64 BOC
 * so TON Connect sends the exact Jetton transfer to the Admin wallet.
 */
export function buildJettonTransferPayloadBase64(params: {
  amount: number;
  decimals: number;
  destinationAddress: string;
  responseAddress: string;
  comment?: string;
}): string {
  const amountUnits = toJettonBaseUnits(params.amount, params.decimals);
  const dest = Address.parse(params.destinationAddress);
  const resp = Address.parse(params.responseAddress);

  const forwardPayload = params.comment
    ? beginCell().storeUint(0, 32).storeStringTail(params.comment).endCell()
    : beginCell().endCell();

  const body = beginCell()
    .storeUint(0x0f8a7ea5, 32) // TEP-74 Jetton transfer op
    .storeUint(0, 64) // query_id
    .storeCoins(amountUnits) // jetton amount
    .storeAddress(dest) // destination (Admin TON wallet)
    .storeAddress(resp) // response_destination (excess gas back to sender)
    .storeBit(false) // no custom_payload
    .storeCoins(1n) // forward_ton_amount (1 nanotons for notification)
    .storeBit(true) // forward_payload as ref
    .storeRef(forwardPayload)
    .endCell();

  return body.toBoc().toString('base64');
}

/**
 * Extracts the hex hash from a TON Connect transaction BOC response.
 */
export function getBocHashHex(bocBase64: string): string {
  const cell = Cell.fromBase64(bocBase64);
  return cell.hash().toString('hex');
}
