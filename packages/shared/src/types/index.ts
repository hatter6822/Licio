// SPDX-License-Identifier: AGPL-3.0-or-later
export type Timestamp = string;

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}
