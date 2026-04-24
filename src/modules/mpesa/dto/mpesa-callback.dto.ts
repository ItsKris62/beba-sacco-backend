/**
 * Type-safe shapes for all Safaricom Daraja callback payloads.
 *
 * Daraja sends different JSON structures depending on the API:
 *   STK Push   → Body.stkCallback
 *   C2B        → Body.C2BPayment (for direct paybill/buy-goods)
 *   B2C Result → Result (top-level)
 *
 * The unified callback endpoint detects the type by inspecting the root keys.
 */

// ─── Shared ───────────────────────────────────────────────────────────────────

export interface DarajaCallbackItem {
  Name: string;
  Value?: string | number;
}

// ─── STK Push callback ────────────────────────────────────────────────────────

export interface StkCallbackMetadata {
  Item: DarajaCallbackItem[];
}

export interface StkCallback {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResultCode: number;
  ResultDesc: string;
  CallbackMetadata?: StkCallbackMetadata;
}

/** Root shape of the STK Push result Daraja POSTs to our callback URL */
export interface StkCallbackPayload {
  Body: {
    stkCallback: StkCallback;
  };
}

/** Extracted fields after parsing STK CallbackMetadata.Item array */
export interface StkCallbackMeta {
  Amount?: string;
  MpesaReceiptNumber?: string;
  Balance?: string;
  TransactionDate?: string;
  PhoneNumber?: string;
}

// ─── C2B callback (direct paybill payment, no STK prompt) ────────────────────

export interface C2bCallbackPayload {
  TransactionType: string;
  TransID: string;         // Safaricom transaction ID (receipt)
  TransTime: string;       // YYYYMMDDHHmmss
  TransAmount: string;
  BusinessShortCode: string;
  BillRefNumber: string;   // Account reference entered by customer
  InvoiceNumber?: string;
  OrgAccountBalance?: string;
  ThirdPartyTransID?: string;
  MSISDN: string;          // Customer phone (E.164)
  FirstName?: string;
  MiddleName?: string;
  LastName?: string;
}

// ─── B2C result callback ──────────────────────────────────────────────────────

export interface B2cResultParameter {
  Key: string;
  Value: string | number;
}

export interface B2cResultParameters {
  ResultParameter: B2cResultParameter[];
}

export interface B2cReferenceItem {
  Key: string;
  Value: string;
}

export interface B2cReferenceData {
  ReferenceItem: B2cReferenceItem | B2cReferenceItem[];
}

export interface B2cResult {
  ResultType: number;
  ResultCode: number;
  ResultDesc: string;
  OriginatorConversationID: string;
  ConversationID: string;
  TransactionID: string;
  ResultParameters?: B2cResultParameters;
  ReferenceData?: B2cReferenceData;
}

/** Root shape of a B2C result Daraja POSTs to our resultUrl */
export interface B2cCallbackPayload {
  Result: B2cResult;
}

/** Extracted fields from B2C ResultParameters */
export interface B2cResultMeta {
  TransactionAmount?: string;
  TransactionReceipt?: string;
  ReceiverPartyPublicName?: string;
  TransactionCompletedDateTime?: string;
  B2CUtilityAccountAvailableFunds?: string;
  B2CWorkingAccountAvailableFunds?: string;
}

// ─── Union type for the unified callback ─────────────────────────────────────

export type MpesaCallbackUnion =
  | StkCallbackPayload
  | C2bCallbackPayload
  | B2cCallbackPayload;

// ─── Type guards ──────────────────────────────────────────────────────────────

export function isStkCallback(payload: unknown): payload is StkCallbackPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'Body' in payload &&
    typeof (payload as StkCallbackPayload).Body === 'object' &&
    'stkCallback' in (payload as StkCallbackPayload).Body
  );
}

export function isC2bCallback(payload: unknown): payload is C2bCallbackPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'TransID' in payload &&
    'MSISDN' in payload
  );
}

export function isB2cCallback(payload: unknown): payload is B2cCallbackPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'Result' in payload &&
    typeof (payload as B2cCallbackPayload).Result === 'object' &&
    'ConversationID' in (payload as B2cCallbackPayload).Result
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Flatten STK CallbackMetadata.Item array into a key-value map */
export function parseStkMeta(items?: DarajaCallbackItem[]): StkCallbackMeta {
  if (!items) return {};
  return Object.fromEntries(
    items
      .filter((i) => i.Value !== undefined)
      .map((i) => [i.Name, String(i.Value)]),
  ) as StkCallbackMeta;
}

/** Flatten B2C ResultParameters.ResultParameter array into a key-value map */
export function parseB2cResultMeta(params?: B2cResultParameters): B2cResultMeta {
  if (!params?.ResultParameter) return {};
  return Object.fromEntries(
    params.ResultParameter.map((p) => [p.Key, String(p.Value)]),
  ) as B2cResultMeta;
}
