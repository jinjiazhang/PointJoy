import { loadAuth } from './vault';
import { ApiError } from './transport';

export function familyPath(tail = '') {
  const id = loadAuth()?.session.familyId;
  if (!id) {
    throw new ApiError('SCOPE_MISMATCH', '请先选择家庭');
  }
  return `/families/${id}${tail}`;
}

export function childPath(childId?: string, tail = '') {
  const c = childId || loadAuth()?.session.childId;
  if (!c) {
    throw new ApiError('VALIDATION_ERROR', '请先选择孩子');
  }
  return familyPath(`/children/${c}${tail}`);
}
