import { get } from './api';
export interface SavedReceipt {
  requestId: string;
  receiptToken: string;
  type: string;
  scope: string;
}
export interface ReceiptView {
  requestId: string;
  type: string;
  scope: string;
  status: string;
  requestedAt: string;
  dueAt: string;
  onlineCompletedAt?: string;
  userVisibleNote?: string;
  supportContact?: string;
  onlineDataStatus?: string;
  backupStatus: 'PENDING' | 'COMPLETED' | 'NOT_STARTED';
  backupPurgeDueAt?: string;
  backupCompletedAt?: string;
}
const KEY = 'pointjoy.privacy-receipts.v1';
export function savedReceipts(): SavedReceipt[] {
  try {
    return uni.getStorageSync(KEY) || [];
  } catch {
    return [];
  }
}
export function saveReceipt(value: SavedReceipt) {
  if (!value.receiptToken) {
    return;
  }
  uni.setStorageSync(KEY, [
    value,
    ...savedReceipts().filter((r) => r.requestId !== value.requestId),
  ]);
}
export function readReceipt(receipt: SavedReceipt) {
  return get<ReceiptView>(`/privacy-receipts/${encodeURIComponent(receipt.receiptToken)}`);
}
